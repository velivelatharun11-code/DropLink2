import { Socket } from 'socket.io-client';
import { ICE_SERVERS } from '../transport/ice';
import { encryptChunk, decryptChunk } from './crypto';

export { ICE_SERVERS };

export type PeerConnectionStatus = 'connecting' | 'connected' | 'failed';

export interface PeerDiagnosticInfo {
  peerId: string;
  peerName?: string;
  status: PeerConnectionStatus;
  iceState: RTCIceConnectionState;
  connectionState: RTCPeerConnectionState;
  openChannelsCount: number;
  totalChannelsCount: number;
}

export interface PeerNode {
  id: string;
  name?: string;
  pc: RTCPeerConnection;
  isPolite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  controlChannel: RTCDataChannel | null;
  stripes: (RTCDataChannel | null)[];
  connected: boolean;
  candidateQueue: RTCIceCandidateInit[];
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

  private encryptionKey: CryptoKey | null = null;
  private isCurrentFileEncrypted: boolean = false;

  // Incoming transfer telemetry tracker for receiver
  private incomingTransfer: {
    fileId: string;
    fileName: string;
    totalBytes: number;
    receivedBytes: number;
    startTime: number;
    lastProgressUpdate: number;
  } | null = null;

  // Callbacks for UI updates
  public onPeersUpdated?: (peerIds: string[]) => void;
  public onPeerConnected?: (peerId: string) => void;
  public onPeerDisconnected?: (peerId: string) => void;
  public onPeerDiagnosticsUpdated?: (diagnostics: PeerDiagnosticInfo[]) => void;
  public onProgress?: (progress: TransferProgress) => void;
  public onFileReceived?: (fileMeta: { id: string; name: string; size: number }) => void;
  public onChatMessage?: (msg: { id: string; text: string; senderId: string; timestamp: number }) => void;
  public onAuthRequired?: (data: { roomId: string; message: string }) => void;
  public onAuthFailed?: (data: { roomId: string; message: string }) => void;
  public onRoomJoined?: (data: { roomId: string; peerId: string; isProtected: boolean; occupancy?: number; transferLock?: any }) => void;
  public onPeerJoined?: (data: { peerId: string; peerName?: string; occupancy?: number; transferLock?: any }) => void;
  public onPeerLeft?: (data: { peerId: string; occupancy?: number }) => void;
  public onOccupancyUpdated?: (data: { occupancy: number; maxPeers: number; roomId?: string }) => void;
  public onTransferLockAcquired?: (data: { senderId: string; senderName: string }) => void;
  public onTransferLockReleased?: (data: { releasedBy: string; reason?: string }) => void;
  public onError?: (error: string) => void;

  public setEncryptionKey(key: CryptoKey | null) {
    this.encryptionKey = key;
  }

  public sendChatMessage(text: string): { id: string; text: string; senderId: string; timestamp: number } {
    const chatMsg = {
      type: 'chat-message',
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      text,
      senderId: this.myPeerId || 'self',
      timestamp: Date.now()
    };
    const payload = JSON.stringify(chatMsg);
    for (const peer of this.peers.values()) {
      if (peer.controlChannel && peer.controlChannel.readyState === 'open') {
        peer.controlChannel.send(payload);
      }
    }
    return chatMsg;
  }

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

  public getMyPeerId(): string {
    return this.myPeerId;
  }

  public getConnectedPeerIds(): string[] {
    return Array.from(this.peers.entries())
      .filter(([, peer]) => peer.connected)
      .map(([id]) => id);
  }

  public leaveRoom() {
    if (this.roomId) {
      this.socket.emit('leave-room');
    }
    Array.from(this.peers.keys()).forEach((peerId) => this.teardownPeer(peerId));
    this.peers.clear();
    this.roomId = '';
    this.incomingTransfer = null;
    this.notifyPeersChanged();
  }

  public initRoom(roomId: string, password?: string, peerName?: string) {
    if (this.roomId && this.roomId !== roomId) {
      this.leaveRoom();
    }
    this.roomId = roomId;
    this.socket.emit('join-room', { roomId, password, peerName });
  }

  public acquireTransferLock(): Promise<{ success: boolean; lock?: any; error?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('acquire-transfer-lock', (res: any) => {
        resolve(res || { success: false, error: 'Signaling server did not respond' });
      });
    });
  }

  public releaseTransferLock(): Promise<boolean> {
    return new Promise((resolve) => {
      this.socket.emit('release-transfer-lock', (res: any) => {
        resolve(!!res?.success);
      });
    });
  }

  private registerSignalingEvents() {
    this.socket.on('connect', () => {
      this.myPeerId = this.socket.id || '';
    });

    this.socket.on('room-auth-required', (data: { roomId: string; message: string }) => {
      if (this.onAuthRequired) {
        this.onAuthRequired(data);
      } else if (this.onError) {
        this.onError(data.message || 'Room password required.');
      }
    });

    this.socket.on('room-auth-failed', (data: { roomId: string; message: string }) => {
      if (this.onAuthFailed) {
        this.onAuthFailed(data);
      } else if (this.onError) {
        this.onError(data.message || 'Invalid room password.');
      }
    });

    this.socket.on('room-joined', (data: {
      roomId: string;
      peerId: string;
      existingPeers: string[];
      isPolite?: boolean;
      isProtected?: boolean;
      occupancy?: number;
      transferLock?: any;
    }) => {
      this.myPeerId = data.peerId;

      data.existingPeers.forEach((remotePeerId) => {
        // Joining peer is polite
        this.setupPeer(remotePeerId, data.isPolite ?? true);
      });
      this.notifyPeersChanged();

      if (this.onRoomJoined) {
        this.onRoomJoined({
          roomId: this.roomId,
          peerId: data.peerId,
          isProtected: !!data.isProtected,
          occupancy: data.occupancy || 1,
          transferLock: data.transferLock
        });
      }
    });

    this.socket.on('peer-joined', (data: { peerId: string; peerName?: string; occupancy?: number; transferLock?: any }) => {
      // Existing peer is impolite (initiator)
      const peerNode = this.setupPeer(data.peerId, false);
      this.notifyPeersChanged();

      // Automatically trigger initial offer negotiation immediately post-auth
      this.initiateOffer(peerNode);

      if (this.onPeerJoined) {
        this.onPeerJoined(data);
      }
    });

    this.socket.on('signal', async ({ senderPeerId, signal }: { senderPeerId: string; signal: any }) => {
      await this.handleIncomingSignal(senderPeerId, signal);
    });

    this.socket.on('peer-left', (data: { peerId: string; occupancy?: number }) => {
      this.teardownPeer(data.peerId);
      this.notifyPeersChanged();
      if (this.onPeerLeft) {
        this.onPeerLeft(data);
      }
    });

    this.socket.on('room-occupancy-update', (data: { occupancy: number; maxPeers: number; roomId?: string }) => {
      if (this.onOccupancyUpdated) {
        this.onOccupancyUpdated(data);
      }
    });

    this.socket.on('transfer-lock-acquired', (data: { senderId: string; senderName: string }) => {
      if (this.onTransferLockAcquired) {
        this.onTransferLockAcquired(data);
      }
    });

    this.socket.on('transfer-lock-released', (data: { releasedBy: string; reason?: string }) => {
      if (this.onTransferLockReleased) {
        this.onTransferLockReleased(data);
      }
    });

    this.socket.on('room-full', ({ message }: { message: string }) => {
      if (this.onError) {
        this.onError(message || 'Room has reached its 5-peer capacity.');
      }
    });
  }

  public getPeerDiagnostics(): PeerDiagnosticInfo[] {
    return Array.from(this.peers.values()).map((peer) => {
      const openControl = peer.controlChannel && peer.controlChannel.readyState === 'open' ? 1 : 0;
      const openStripes = peer.stripes.filter((s) => s && s.readyState === 'open').length;
      const openChannelsCount = openControl + openStripes;

      let status: PeerConnectionStatus = 'connecting';
      const isFailed =
        peer.pc.connectionState === 'failed' ||
        peer.pc.iceConnectionState === 'failed';

      if (isFailed) {
        status = 'failed';
      } else if (openChannelsCount >= 5 || (openControl === 1 && peer.connected)) {
        status = 'connected';
      }

      return {
        peerId: peer.id,
        peerName: peer.name,
        status,
        iceState: peer.pc.iceConnectionState,
        connectionState: peer.pc.connectionState,
        openChannelsCount,
        totalChannelsCount: this.STRIPE_COUNT + 1
      };
    });
  }

  private notifyDiagnosticsChanged() {
    if (this.onPeerDiagnosticsUpdated) {
      this.onPeerDiagnosticsUpdated(this.getPeerDiagnostics());
    }
  }

  public retryPeer(peerId: string): void {
    const existing = this.peers.get(peerId);
    const peerName = existing?.name;
    const isPolite = existing ? existing.isPolite : true;

    this.teardownPeer(peerId);

    const newPeer = this.setupPeer(peerId, isPolite, peerName);
    this.notifyPeersChanged();
    this.notifyDiagnosticsChanged();

    if (!isPolite) {
      this.initiateOffer(newPeer);
    } else {
      this.socket.emit('signal', {
        targetPeerId: peerId,
        signal: { type: 'renegotiate-request' }
      });
    }
  }

  private setupPeer(remotePeerId: string, isPolite: boolean, peerName?: string): PeerNode {
    if (this.peers.has(remotePeerId)) {
      const existing = this.peers.get(remotePeerId)!;
      if (peerName) existing.name = peerName;
      return existing;
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);

    let controlChannel: RTCDataChannel | null = null;
    const stripes: (RTCDataChannel | null)[] = [];

    // The designated offerer (isPolite === false) explicitly pre-creates control (id: 0) and 4 stripes (id: 1..4)
    if (!isPolite) {
      try {
        controlChannel = pc.createDataChannel('control');
        controlChannel.binaryType = 'arraybuffer';
      } catch (e) {
        console.error('[WebRTC] Failed to pre-create control channel:', e);
      }

      for (let i = 0; i < this.STRIPE_COUNT; i++) {
        try {
          const stripe = pc.createDataChannel(`stripe-${i}`);
          stripe.binaryType = 'arraybuffer';
          stripes.push(stripe);
        } catch (e) {
          console.error(`[WebRTC] Failed to pre-create stripe-${i}:`, e);
          stripes.push(null);
        }
      }
    } else {
      for (let i = 0; i < this.STRIPE_COUNT; i++) {
        stripes.push(null);
      }
    }

    const peerNode: PeerNode = {
      id: remotePeerId,
      name: peerName || `Device-${remotePeerId.substring(0, 4).toUpperCase()}`,
      pc,
      isPolite,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      controlChannel,
      stripes,
      connected: false,
      candidateQueue: []
    };

    this.peers.set(remotePeerId, peerNode);

    // Fast connection readiness tracking across data channels & pc states
    const updateConnectedStatus = () => {
      const openControl = peerNode.controlChannel && peerNode.controlChannel.readyState === 'open';
      const openStripes = peerNode.stripes.filter((s) => s && s.readyState === 'open').length;
      const pcReady =
        pc.connectionState === 'connected' ||
        pc.iceConnectionState === 'connected' ||
        pc.iceConnectionState === 'completed';

      // Remote peer is considered connected when control channel is open and communication is active
      const isNowConnected = Boolean(openControl && (openStripes >= 1 || pcReady));

      if (peerNode.connected !== isNowConnected) {
        peerNode.connected = isNowConnected;
        if (isNowConnected) {
          if (this.onPeerConnected) {
            this.onPeerConnected(remotePeerId);
          }
        } else {
          if (this.onPeerDisconnected) {
            this.onPeerDisconnected(remotePeerId);
          }
        }
        this.notifyPeersChanged();
      }

      this.notifyDiagnosticsChanged();
    };

    // The answerer on datachannel event attaches listeners to all received lanes
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.binaryType = 'arraybuffer';

      const cId = channel.id ?? -1;
      if (channel.label === 'control' || cId === 0) {
        peerNode.controlChannel = channel;
        this.attachControlListeners(channel);
        channel.onopen = updateConnectedStatus;
        channel.onclose = updateConnectedStatus;
        channel.onerror = updateConnectedStatus;
      } else if (channel.label.startsWith('stripe-') || (cId >= 1 && cId <= this.STRIPE_COUNT)) {
        const idx = channel.label.startsWith('stripe-')
          ? parseInt(channel.label.replace('stripe-', ''), 10)
          : cId - 1;
        peerNode.stripes[idx] = channel;
        this.attachStripeListeners(channel, idx);
        channel.onopen = updateConnectedStatus;
        channel.onclose = updateConnectedStatus;
        channel.onerror = updateConnectedStatus;
      }

      updateConnectedStatus();
    };

    // Attach listeners on offerer-created channels
    if (controlChannel) {
      this.attachControlListeners(controlChannel);
      controlChannel.onopen = updateConnectedStatus;
      controlChannel.onclose = updateConnectedStatus;
      controlChannel.onerror = updateConnectedStatus;
    }

    stripes.forEach((stripe, i) => {
      if (stripe) {
        this.attachStripeListeners(stripe, i);
        stripe.onopen = updateConnectedStatus;
        stripe.onclose = updateConnectedStatus;
        stripe.onerror = updateConnectedStatus;
      }
    });

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        try {
          pc.restartIce();
        } catch {}
      }
      updateConnectedStatus();
    };

    this.attachPeerConnectionListeners(peerNode, updateConnectedStatus);

    return peerNode;
  }

  private async initiateOffer(peer: PeerNode) {
    try {
      peer.makingOffer = true;
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this.socket.emit('signal', {
        targetPeerId: peer.id,
        signal: { description: peer.pc.localDescription }
      });
    } catch (err) {
      console.error(`[WebRTC] Failed to initiate offer for ${peer.id}:`, err);
    } finally {
      peer.makingOffer = false;
    }
  }

  private attachPeerConnectionListeners(peer: PeerNode, onConnectionChange: () => void) {
    const { pc, id } = peer;

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
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
      onConnectionChange();
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.teardownPeer(id);
      }
    };
  }

  private async handleIncomingSignal(senderId: string, signal: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; type?: string }) {
    let peer = this.peers.get(senderId);
    if (!peer) {
      const isPolite = this.myPeerId > senderId;
      peer = this.setupPeer(senderId, isPolite);
    }

    if (signal.type === 'renegotiate-request') {
      console.log(`[WebRTC] Received renegotiation request from ${senderId}, initiating fresh offer...`);
      this.initiateOffer(peer);
      return;
    }

    const { pc } = peer;

    try {
      if (signal.description) {
        const description = signal.description;
        const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
        const offerCollision = description.type === 'offer' && !readyForOffer;

        peer.ignoreOffer = !peer.isPolite && offerCollision;
        if (peer.ignoreOffer) {
          return;
        }

        peer.isSettingRemoteAnswerPending = description.type === 'answer';
        await pc.setRemoteDescription(description);
        peer.isSettingRemoteAnswerPending = false;

        // Drain queued ICE candidates
        if (peer.candidateQueue.length > 0) {
          for (const cand of peer.candidateQueue) {
            try {
              await pc.addIceCandidate(cand);
            } catch (err) {
              console.warn('[WebRTC] Candidate queue drain error:', err);
            }
          }
          peer.candidateQueue = [];
        }

        if (description.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.socket.emit('signal', {
            targetPeerId: senderId,
            signal: { description: pc.localDescription }
          });
        }
      } else if (signal.candidate) {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          try {
            await pc.addIceCandidate(signal.candidate);
          } catch (err) {
            if (!peer.ignoreOffer) {
              console.error(`[WebRTC] Candidate error for peer ${senderId}:`, err);
            }
          }
        } else {
          peer.candidateQueue.push(signal.candidate);
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
        if (message.type === 'chat-message') {
          if (this.onChatMessage) {
            this.onChatMessage({
              id: message.id,
              text: message.text,
              senderId: message.senderId,
              timestamp: message.timestamp
            });
          }
        } else if (message.type === 'file-header') {
          this.isCurrentFileEncrypted = !!message.isEncrypted;
          if (message.isEncrypted && !this.encryptionKey) {
            if (this.onError) {
              this.onError('Received an encrypted file, but no room password is set.');
            }
          }
          this.incomingTransfer = {
            fileId: message.fileId,
            fileName: message.fileName,
            totalBytes: message.fileSize,
            receivedBytes: 0,
            startTime: performance.now(),
            lastProgressUpdate: performance.now()
          };
          if (this.opfsWorker) {
            this.opfsWorker.postMessage({
              type: 'INIT_FILE_STREAM',
              fileId: message.fileId,
              fileName: message.fileName,
              fileSize: message.fileSize,
              mimeType: message.mimeType || 'application/octet-stream'
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
          this.isCurrentFileEncrypted = false;
          if (this.incomingTransfer) {
            if (this.onProgress) {
              this.onProgress({
                fileId: this.incomingTransfer.fileId,
                fileName: this.incomingTransfer.fileName,
                totalBytes: this.incomingTransfer.totalBytes,
                transferredBytes: this.incomingTransfer.totalBytes,
                speedBps: 0,
                percentage: 100,
                activeStripes: [0, 1, 2, 3],
                connectedPeersCount: this.getConnectedPeerIds().length
              });
            }
            this.incomingTransfer = null;
          }
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
    channel.onmessage = async (event) => {
      let buffer = event.data as ArrayBuffer;

      if (this.isCurrentFileEncrypted && this.encryptionKey) {
        try {
          buffer = await decryptChunk(buffer, this.encryptionKey);
        } catch (err) {
          console.error('[WebRTC Decrypt Error]', err);
          if (this.onError) {
            this.onError('Decryption failed: Incorrect room password or corrupt data.');
          }
          return;
        }
      }

      if (this.incomingTransfer) {
        this.incomingTransfer.receivedBytes += buffer.byteLength;
        const now = performance.now();
        if (
          now - this.incomingTransfer.lastProgressUpdate > 30 ||
          this.incomingTransfer.receivedBytes >= this.incomingTransfer.totalBytes
        ) {
          const elapsedSec = (now - this.incomingTransfer.startTime) / 1000;
          const speedBps = elapsedSec > 0 ? this.incomingTransfer.receivedBytes / elapsedSec : 0;
          const percentage = Math.min(
            100,
            Math.round((this.incomingTransfer.receivedBytes / this.incomingTransfer.totalBytes) * 100)
          );

          if (this.onProgress) {
            this.onProgress({
              fileId: this.incomingTransfer.fileId,
              fileName: this.incomingTransfer.fileName,
              totalBytes: this.incomingTransfer.totalBytes,
              transferredBytes: this.incomingTransfer.receivedBytes,
              speedBps,
              percentage,
              activeStripes: [stripeIndex],
              connectedPeersCount: this.getConnectedPeerIds().length
            });
          }
          this.incomingTransfer.lastProgressUpdate = now;
        }
      }

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
    const activePeers = Array.from(this.peers.values()).filter(
      (p) => p.connected && p.controlChannel && p.controlChannel.readyState === 'open'
    );
    if (activePeers.length === 0) {
      throw new Error('No connected peers in room to stream file.');
    }

    const fileId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const headerPayload = JSON.stringify({
      type: 'file-header',
      fileId,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      isEncrypted: !!this.encryptionKey
    });

    for (const peer of activePeers) {
      if (peer.controlChannel && peer.controlChannel.readyState === 'open') {
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
      let chunkBuffer = await blobSlice.arrayBuffer();

      if (this.encryptionKey) {
        chunkBuffer = await encryptChunk(chunkBuffer, this.encryptionKey);
      }

      for (const peer of activePeers) {
        const availableStripes = peer.stripes.filter(
          (s): s is RTCDataChannel => Boolean(s && s.readyState === 'open')
        );
        const channel =
          availableStripes.length > 0
            ? availableStripes[stripeIndex % availableStripes.length]
            : peer.controlChannel;

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
      if (peer.controlChannel && peer.controlChannel.readyState === 'open') {
        peer.controlChannel.send(completionPayload);
      }
    }
  }

  private async enforceBackpressure(peers: PeerNode[], stripeIdx: number): Promise<void> {
    const isOverloaded = () =>
      peers.some((peer) => {
        const availableStripes = peer.stripes.filter(
          (s): s is RTCDataChannel => Boolean(s && s.readyState === 'open')
        );
        if (availableStripes.length === 0) return false;
        const channel = availableStripes[stripeIdx % availableStripes.length];
        return channel && channel.bufferedAmount > this.MAX_BUFFER_THRESHOLD;
      });

    if (!isOverloaded()) return;

    while (
      peers.some((peer) => {
        const availableStripes = peer.stripes.filter(
          (s): s is RTCDataChannel => Boolean(s && s.readyState === 'open')
        );
        if (availableStripes.length === 0) return false;
        const channel = availableStripes[stripeIdx % availableStripes.length];
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
        peer.controlChannel?.close();
        peer.stripes.forEach((stripe) => stripe?.close());
        peer.pc.close();
      } catch {
        // Ignored during teardown
      }
      this.peers.delete(peerId);
      this.notifyDiagnosticsChanged();
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