import { io, Socket } from 'socket.io-client';
import { getDefaultIceServers } from './ice';

export class P2PTransport {
  public pc: RTCPeerConnection;
  public socket: Socket;
  public dataChannels: RTCDataChannel[] = [];
  public targetPeerId: string | null = null;
  private roundRobinIndex = 0;
  private channelCount = 4;
  private makingOffer = false;
  private remoteCandidateQueue: RTCIceCandidateInit[] = [];
  private localCandidateQueue: RTCIceCandidate[] = [];
  private onChunkReceivedCallback?: (data: ArrayBuffer | string) => void;
  private onReadyCallback?: () => void;
  private onStateChangeCallback?: (state: string) => void;

  constructor(signalingUrl = `http://${window.location.hostname}:3001`) {
    this.pc = new RTCPeerConnection({
      iceServers: getDefaultIceServers(),
    });
    this.socket = io(signalingUrl);
    this.setupSignaling();
    this.setupConnectionMonitoring();
  }

  private setupConnectionMonitoring() {
    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      if (this.onStateChangeCallback) {
        this.onStateChangeCallback(`ICE: ${state}`);
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (this.onStateChangeCallback) {
        this.onStateChangeCallback(`P2P: ${state}`);
      }
    };
  }

  private flushLocalCandidates() {
    if (!this.targetPeerId) return;
    while (this.localCandidateQueue.length > 0) {
      const candidate = this.localCandidateQueue.shift();
      if (candidate) {
        this.socket.emit('signal', {
          to: this.targetPeerId,
          signal: { type: 'candidate', candidate },
        });
      }
    }
  }

  private checkAllChannelsOpen() {
    const openChannels = this.dataChannels.filter((dc) => dc.readyState === 'open');
    if (openChannels.length === this.channelCount && this.onReadyCallback) {
      this.onReadyCallback();
    }
  }

  private setupDataChannel(dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer';

    if (!this.dataChannels.includes(dc)) {
      this.dataChannels.push(dc);
    }

    dc.onmessage = (event) => {
      if (this.onChunkReceivedCallback) {
        this.onChunkReceivedCallback(event.data);
      }
    };

    dc.onopen = () => {
      this.checkAllChannelsOpen();
    };
  }

  private setupSignaling() {
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        if (this.targetPeerId) {
          this.socket.emit('signal', {
            to: this.targetPeerId,
            signal: { type: 'candidate', candidate: e.candidate },
          });
        } else {
          // Buffer locally generated candidates until target peer joins
          this.localCandidateQueue.push(e.candidate);
        }
      }
    };

    this.pc.ondatachannel = (e) => {
      this.setupDataChannel(e.channel);
    };

    this.socket.on('signal', async ({ from, signal }) => {
      this.targetPeerId = from;
      this.flushLocalCandidates();

      try {
        if (signal.type === 'offer') {
          await this.pc.setRemoteDescription(new RTCSessionDescription(signal));

          while (this.remoteCandidateQueue.length > 0) {
            const cand = this.remoteCandidateQueue.shift();
            if (cand) await this.pc.addIceCandidate(new RTCIceCandidate(cand));
          }

          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.socket.emit('signal', { to: from, signal: answer });
        } else if (signal.type === 'answer') {
          if (this.pc.signalingState === 'have-local-offer') {
            await this.pc.setRemoteDescription(new RTCSessionDescription(signal));

            while (this.remoteCandidateQueue.length > 0) {
              const cand = this.remoteCandidateQueue.shift();
              if (cand) await this.pc.addIceCandidate(new RTCIceCandidate(cand));
            }
          }
        } else if (signal.type === 'candidate') {
          if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
            await this.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } else {
            this.remoteCandidateQueue.push(signal.candidate);
          }
        }
      } catch (err) {
        console.warn('Signaling error recovered:', err);
      }
    });
  }

  public joinRoom(roomId: string) {
    this.socket.emit('join-room', roomId);

    this.socket.on('peer-joined', async (peerId) => {
      this.targetPeerId = peerId;
      this.flushLocalCandidates();
      await this.createStripedChannelsAndOffer();
    });
  }

  private async createStripedChannelsAndOffer(): Promise<void> {
    if (this.makingOffer) return;
    this.makingOffer = true;

    this.dataChannels = [];

    for (let i = 0; i < this.channelCount; i++) {
      const dc = this.pc.createDataChannel(`stripe-${i}`, {
        ordered: false,
        maxRetransmits: 5,
      });
      this.setupDataChannel(dc);
    }

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    this.socket.emit('signal', {
      to: this.targetPeerId,
      signal: offer,
    });

    this.makingOffer = false;
  }

  public onChunkReceived(cb: (data: ArrayBuffer | string) => void) {
    this.onChunkReceivedCallback = cb;
  }

  public onReady(cb: () => void) {
    this.onReadyCallback = cb;
  }

  public onStateChange(cb: (state: string) => void) {
    this.onStateChangeCallback = cb;
  }

  public async sendChunk(buffer: ArrayBuffer): Promise<void> {
    const openChannels = this.dataChannels.filter((dc) => dc.readyState === 'open');
    if (!openChannels.length) return;

    const dc = openChannels[this.roundRobinIndex % openChannels.length];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % openChannels.length;

    if (dc.bufferedAmount > 2 * 1024 * 1024) {
      await new Promise<void>((res) => {
        dc.onbufferedamountlow = () => res();
      });
    }

    dc.send(buffer);
  }
}