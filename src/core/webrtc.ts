import { Socket } from 'socket.io-client';
import { rtcConfiguration } from '../transport/ice';

export interface PeerNode {
  id: string;
  pc: RTCPeerConnection;
  isPolite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  controlChannel: RTCDataChannel;
  stripes: RTCDataChannel[];
  connected: boolean;
}

export interface TransferProgress {
  fileId: string;
  fileName: string;
  totalBytes: number;
  transferredBytes: number;
  speedBps: number;
  percentage: number;
  activeStripes: number[];
  connectedPeersCount: number;
}

export class MeshWebRTCManager {
  private socket: Socket;
  private myPeerId: string = '';
  private roomId: string = '';
  private peers: Map<string, PeerNode> = new Map();
  private opfsWorker: Worker | null = null;

  // Flow control & Backpressure parameters
  private readonly CHUNK_SIZE = 64 * 1024; // 64 KB slices
  private readonly MAX_BUFFER_THRESHOLD = 16 * 1024 * 1024; // 16 MB max buffer
  private readonly LOW_WATERMARK = 4 * 1024 * 1024; // 4 MB drain threshold
  private readonly STRIPE_COUNT = 4;

  // Callbacks for UI updates
  public onPeersUpdated?: (peerIds: string[]) => void;
  public onProgress?: (progress: TransferProgress) => void;
  public onFileReceived?: (fileMeta: { id: string; name: string; size: number }) => void;
  public onError?: (error: string) => void;

  constructor(socket: Socket, worker?: Worker) {
    this.socket = socket;
    this.opfsWorker = worker || null;
    this.registerSignalingEvents();
  }

  public setWorker(worker: Worker) {
    this.opfsWorker = worker;
  }

  public getRoomId(): string {
    return this.roomId;
  }

  public getConnectedPeerIds(): string[] {
    return Array.from(this.peers.entries())
      .filter(([, peer]) => peer.connected)
      .map(([id]) => id);
  }

  public leaveRoom() {
    Array.from(this.peers.keys()).forEach((peerId) => this.teardownPeer(peerId));
    this.peers.clear();
    this.notifyPeersChanged();
  }

  public initRoom(roomId: string) {
    if (this.roomId && this.roomId !== roomId) {
      this.leaveRoom();
    }
    this.roomId = roomId;
    this.socket.emit('join-room', roomId);
  }

  private registerSignalingEvents() {
    this.socket.on('connect', () => {
      this.myPeerId = this.socket.id || '';
    });

    this.socket.on('room-joined', ({ peerId, existingPeers, isPolite }: { peerId: string; existingPeers: string[]; isPolite?: boolean }) => {
      this.myPeerId = peerId;

      existingPeers.forEach((remotePeerId) => {
        this.setupPeer(remotePeerId, isPolite ?? true);
      });
      this.notifyPeersChanged();
    });

    this.socket.on('peer-joined', ({ peerId }: { peerId: string }) => {
      this.setupPeer(peerId, false);
      this.notifyPeersChanged();
    });

    this.socket.on('signal', async ({ senderPeerId, signal }: { senderPeerId: string; signal: any }) => {
      await this.handleIncomingSignal(senderPeerId, signal);
    });

    this.socket.on('peer-left', ({ peerId }: { peerId: string }) => {
      this.teardownPeer(peerId);
      this.notifyPeersChanged();
    });

    this.socket.on('room-full', ({ message }: { message: string }) => {
      if (this.onError) {
        this.onError(message || 'Room has reached its 5-peer capacity.');
      }
    });
  }

  private setupPeer(remotePeerId: string, isPolite: boolean): PeerNode {
    if (this.peers.has(remotePeerId)) {
      return this.peers.get(remotePeerId)!;
    }

    const pc = new RTCPeerConnection(rtcConfiguration);

    const controlChannel = pc.createDataChannel('control', {
      negotiated: true,
      id: 0
    });
    controlChannel.binaryType = 'arraybuffer';

    const stripes: RTCDataChannel[] = [];
    for (let i = 0; i < this.STRIPE_COUNT; i++) {
      const stripe = pc.createDataChannel(`stripe-${i}`, {
        negotiated: true,
        id: i + 1
      });
      stripe.binaryType = 'arraybuffer';
      this.attachStripeListeners(stripe, i);
      stripes.push(stripe);
    }

    const peerNode: PeerNode = {
      id: remotePeerId,
      pc,
      isPolite,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      controlChannel,
      stripes,
      connected: false
    };

    this.peers.set(remotePeerId, peerNode);

    this.attachControlListeners(controlChannel);
    this.attachPeerConnectionListeners(peerNode);

    return peerNode;
  }

  private attachPeerConnectionListeners(peer: PeerNode) {
    const { pc, id } = peer;

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.socket.emit('signal', {
          targetPeerId: id,
          signal: { description: pc.localDescription }
        });
      } catch (err) {
        console.error(`[WebRTC] Negotiation error with peer ${id}:`, err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.socket.emit('signal', {
          targetPeerId: id,
          signal: { candidate }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      peer.connected = pc.connectionState === 'connected';
      this.notifyPeersChanged();
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.teardownPeer(id);
      }
    };
  }

  private async handleIncomingSignal(senderId: string, signal: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    let peer = this.peers.get(senderId);
    if (!peer) {
      const isPolite = this.myPeerId > senderId;
      peer = this.setupPeer(senderId, isPolite);
    }

    const { pc } = peer;

    try {
      if (signal.description) {
        const description = signal.description;
        const offerCollision =
          description.type === 'offer' &&
          (peer.makingOffer || pc.signalingState !== 'stable');

        peer.ignoreOffer = !peer.isPolite && offerCollision;
        if (peer.ignoreOffer) {
          return;
        }

        peer.isSettingRemoteAnswerPending = description.type === 'answer';
        await pc.setRemoteDescription(description);
        peer.isSettingRemoteAnswerPending = false;

        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.socket.emit('signal', {
            targetPeerId: senderId,
            signal: { description: pc.localDescription }
          });
        }
      } else if (signal.candidate) {
        try {
          await pc.addIceCandidate(signal.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) {
            console.error(`[WebRTC] Candidate error for peer ${senderId}:`, err);
          }
        }
      }
    } catch (err) {
      console.error(`[WebRTC] Signal handling failed from ${senderId}:`, err);
    }
  }

  private attachControlListeners(channel: RTCDataChannel) {
    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'file-header') {
          if (this.opfsWorker) {
            this.opfsWorker.postMessage({
              type: 'INIT_FILE_STREAM',
              fileId: message.fileId,
              fileName: message.fileName,
              fileSize: message.fileSize
            });
          }
          if (this.onFileReceived) {
            this.onFileReceived({
              id: message.fileId,
              name: message.fileName,
              size: message.fileSize
            });
          }
        } else if (message.type === 'file-complete') {
          if (this.opfsWorker) {
            this.opfsWorker.postMessage({
              type: 'CLOSE_FILE_STREAM',
              fileId: message.fileId
            });
          }
        }
      } catch (e) {
        console.error(`[Control] Error reading control payload:`, e);
      }
    };
  }

  private attachStripeListeners(channel: RTCDataChannel, stripeIndex: number) {
    channel.onmessage = (event) => {
      const buffer = event.data as ArrayBuffer;

      if (this.opfsWorker) {
        this.opfsWorker.postMessage(
          {
            type: 'WRITE_CHUNK',
            stripeIndex,
            chunk: buffer
          },
          [buffer]
        );
      }
    };
  }

  public async streamFileToAllPeers(file: File): Promise<void> {
    const activePeers = Array.from(this.peers.values()).filter((p) => p.connected);
    if (activePeers.length === 0) {
      throw new Error('No connected peers in room to stream file.');
    }

    const fileId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const headerPayload = JSON.stringify({
      type: 'file-header',
      fileId,
      fileName: file.name,
      fileSize: file.size
    });

    for (const peer of activePeers) {
      if (peer.controlChannel.readyState === 'open') {
        peer.controlChannel.send(headerPayload);
      }
    }

    let offset = 0;
    let stripeIndex = 0;
    let transferredBytes = 0;
    const startTime = performance.now();
    let lastProgressUpdate = performance.now();

    while (offset < file.size) {
      await this.enforceBackpressure(activePeers, stripeIndex);

      const sliceEnd = Math.min(offset + this.CHUNK_SIZE, file.size);
      const blobSlice = file.slice(offset, sliceEnd);
      const chunkBuffer = await blobSlice.arrayBuffer();

      for (const peer of activePeers) {
        const channel = peer.stripes[stripeIndex];
        if (channel && channel.readyState === 'open') {
          channel.send(chunkBuffer);
        }
      }

      transferredBytes += chunkBuffer.byteLength;
      offset = sliceEnd;
      stripeIndex = (stripeIndex + 1) % this.STRIPE_COUNT;

      const now = performance.now();
      if (now - lastProgressUpdate > 16 || offset >= file.size) {
        const elapsedSec = (now - startTime) / 1000;
        const speedBps = elapsedSec > 0 ? transferredBytes / elapsedSec : 0;
        const percentage = Math.round((transferredBytes / file.size) * 100);

        if (this.onProgress) {
          this.onProgress({
            fileId,
            fileName: file.name,
            totalBytes: file.size,
            transferredBytes,
            speedBps,
            percentage,
            activeStripes: [stripeIndex],
            connectedPeersCount: activePeers.length
          });
        }
        lastProgressUpdate = now;
      }
    }

    const completionPayload = JSON.stringify({ type: 'file-complete', fileId });
    for (const peer of activePeers) {
      if (peer.controlChannel.readyState === 'open') {
        peer.controlChannel.send(completionPayload);
      }
    }
  }

  private async enforceBackpressure(peers: PeerNode[], stripeIdx: number): Promise<void> {
    const isOverloaded = () =>
      peers.some((peer) => {
        const channel = peer.stripes[stripeIdx];
        return channel && channel.bufferedAmount > this.MAX_BUFFER_THRESHOLD;
      });

    if (!isOverloaded()) return;

    while (
      peers.some((peer) => {
        const channel = peer.stripes[stripeIdx];
        return channel && channel.bufferedAmount > this.LOW_WATERMARK;
      })
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private teardownPeer(peerId: string) {
    const peer = this.peers.get(peerId);
    if (peer) {
      try {
        peer.controlChannel.close();
        peer.stripes.forEach((stripe) => stripe.close());
        peer.pc.close();
      } catch {
        // Ignored during teardown
      }
      this.peers.delete(peerId);
    }
  }

  private notifyPeersChanged() {
    if (this.onPeersUpdated) {
      this.onPeersUpdated(this.getConnectedPeerIds());
    }
  }

  public destroy() {
    Array.from(this.peers.keys()).forEach((peerId) => this.teardownPeer(peerId));
    this.peers.clear();
    this.socket.off('room-joined');
    this.socket.off('peer-joined');
    this.socket.off('signal');
    this.socket.off('peer-left');
    this.socket.off('room-full');
  }
}