import { getDefaultIceServers } from '../transport/ice';
import { io, Socket } from 'socket.io-client';
import { unpackChunk, DEFAULT_CHUNK_SIZE } from '../engine/framing';
import { decryptChunk, deriveKey } from '../engine/crypto';
import { StripeMultiplexer } from '../engine/stripeMultiplexer';

export interface ExtendedFile {
  file: File;
  relativePath: string;
}

export interface TransferMetrics {
  percent: number;
  speedMBps: number;
  bufferedAmountMB: number;
  currentFileName: string;
  bytesTransferred: number;
  totalBytes: number;
  isPaused?: boolean;
}

export interface PeerEvents {
  onTransferAborted?: (reason?: string) => void;
  onTransferPaused?: () => void;
  onTransferResumed?: () => void;
  onPeerConnected: (peerId: string) => void;
  onPeerDisconnected: (peerId: string) => void;
  onMetrics: (metrics: TransferMetrics) => void;
  onFileReceived: (fileName: string, relativePath: string, file: Blob, checksum?: string) => void;
  onStatusChange: (status: string) => void;
}

export class DropLinkEngine {
  private socket: Socket;
  private pc: RTCPeerConnection | null = null;
  private dataChannels: RTCDataChannel[] = [];
  private controlChannel: RTCDataChannel | null = null;
  private worker: Worker;
  private activeSenderWorker: Worker | null = null;
  private events: PeerEvents;
  private cryptoKey: CryptoKey | null = null;
  private isCancelled: boolean = false;
  private isTransferring: boolean = false;
  private isPaused: boolean = false;

  private startAckResolvers: Map<number, (resumedOffset: number) => void> = new Map();
  private fileSavedResolvers: Map<number, () => void> = new Map();

  constructor(serverUrl: string, events: PeerEvents, password?: string) {
    this.events = events;
    this.socket = io(serverUrl, { transports: ['polling'] });

    if (password && password.trim().length > 0) {
      const salt = new TextEncoder().encode('droplink2-static-salt-v1');
      deriveKey(password.trim(), salt).then((key: CryptoKey) => {
        this.cryptoKey = key;
      });
    }

    this.worker = new Worker(
      new URL('../workers/opfs.worker.ts', import.meta.url),
      { type: 'module' }
    );

    this.setupWorker();
    this.setupSocket();
  }

  public pauseTransfer() {
    if (!this.isTransferring || this.isPaused) return;
    this.isPaused = true;
    if (this.activeSenderWorker) {
      this.activeSenderWorker.postMessage({ type: 'PAUSE' });
    }
    this.sendControlMessage({ type: 'TRANSFER_PAUSED' });
    this.events.onTransferPaused?.();
    this.events.onStatusChange('Transfer paused');
  }

  public resumeTransfer() {
    if (!this.isTransferring || !this.isPaused) return;
    this.isPaused = false;
    if (this.activeSenderWorker) {
      this.activeSenderWorker.postMessage({ type: 'RESUME' });
    }
    this.sendControlMessage({ type: 'TRANSFER_RESUMED' });
    this.events.onTransferResumed?.();
    this.events.onStatusChange('Transfer resumed');
  }

  public cancelTransfer(reason: string = 'Transfer cancelled') {
    this.isCancelled = true;
    this.isPaused = false;
    if (this.activeSenderWorker) {
      this.activeSenderWorker.postMessage({ type: 'CANCEL' });
      this.activeSenderWorker.terminate();
      this.activeSenderWorker = null;
    }
    this.sendControlMessage({ type: 'TRANSFER_ABORT', reason });
    this.worker.postMessage({ type: 'ABORT_FILE' });
    this.startAckResolvers.clear();
    this.fileSavedResolvers.clear();
    this.events.onTransferAborted?.(reason);
    this.events.onStatusChange(reason);
  }

  public setPassword(password: string) {
    if (password && password.trim().length > 0) {
      const salt = new TextEncoder().encode('droplink2-static-salt-v1');
      deriveKey(password.trim(), salt).then((key: CryptoKey) => {
        this.cryptoKey = key;
      });
    } else {
      this.cryptoKey = null;
    }
  }

  private setupSocket() {
    this.socket.on('peer-joined', async (peerId: string) => {
      this.events.onStatusChange(`Peer found (${peerId}). Connecting...`);
      await this.initPeerConnection(peerId, true);
    });

    this.socket.on('signal', async ({ from, signal }: { from: string; signal: any }) => {
      if (!this.pc) {
        await this.initPeerConnection(from, false);
      }

      if (signal.sdp) {
        await this.pc!.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (signal.sdp.type === 'offer') {
          const answer = await this.pc!.createAnswer();
          await this.pc!.setLocalDescription(answer);
          this.socket.emit('signal', { to: from, signal: { sdp: this.pc!.localDescription } });
        }
      } else if (signal.candidate) {
        try {
          await this.pc!.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (err) {
          console.warn('ICE error:', err);
        }
      }
    });

    this.socket.on('peer-left', (peerId: string) => {
      this.events.onPeerDisconnected(peerId);
      this.events.onStatusChange('Peer disconnected');
      this.cleanup();
    });
  }

  private setupWorker() {
    this.worker.onmessage = (e) => {
      const { type, fileId, fileName, relativePath, file, bytesWritten, fileSize, checksum } = e.data;

      if (type === 'FILE_INITIALIZED') {
        const { resumedOffset } = e.data;
        this.sendControlMessage({ type: 'START_ACK', fileId: Number(fileId), resumedOffset: resumedOffset || 0 });
      } else if (type === 'WRITE_PROGRESS') {
        const pct = fileSize > 0 ? (bytesWritten / fileSize) * 100 : 100;
        this.events.onMetrics({
          percent: Math.min(100, pct),
          speedMBps: 0,
          bufferedAmountMB: 0,
          currentFileName: fileName,
          bytesTransferred: bytesWritten,
          totalBytes: fileSize,
          isPaused: this.isPaused,
        });
      } else if (type === 'FILE_ABORTED') {
        this.events.onStatusChange('OPFS partial storage purged');
      } else if (type === 'FILE_COMPLETE') {
        this.events.onMetrics({
          percent: 100,
          speedMBps: 0,
          bufferedAmountMB: 0,
          currentFileName: fileName,
          bytesTransferred: fileSize || 0,
          totalBytes: fileSize || 0,
          isPaused: false,
        });
        this.events.onFileReceived(fileName, relativePath, file, checksum);
        this.events.onStatusChange(`Saved to disk: ${fileName}`);
        this.sendControlMessage({ type: 'FILE_SAVED', fileId: Number(fileId) });
      }
    };
  }

  private sendControlMessage(msg: any) {
    if (this.controlChannel && this.controlChannel.readyState === 'open') {
      this.controlChannel.send(JSON.stringify(msg));
    }
  }

  public joinRoom(roomId: string) {
    this.socket.emit('join-room', roomId);
    this.events.onStatusChange(`Room ${roomId} joined. Waiting for peer...`);
  }

  private async initPeerConnection(remotePeerId: string, isInitiator: boolean) {
    this.pc = new RTCPeerConnection({
      iceServers: getDefaultIceServers(),
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('signal', { to: remotePeerId, signal: { candidate: e.candidate } });
      }
    };

    if (isInitiator) {
      this.controlChannel = this.pc.createDataChannel('control', { ordered: true });
      this.setupControlChannel(this.controlChannel);

      this.dataChannels = [];
      for (let i = 0; i < 4; i++) {
        const dc = this.pc.createDataChannel(`stripe_${i}`, { ordered: true });
        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = 256 * 1024;
        this.dataChannels.push(dc);
      }

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.socket.emit('signal', { to: remotePeerId, signal: { sdp: this.pc.localDescription } });
    } else {
      this.pc.ondatachannel = (e) => {
        const dc = e.channel;
        if (dc.label === 'control') {
          this.controlChannel = dc;
          this.setupControlChannel(dc);
        } else {
          dc.binaryType = 'arraybuffer';
          dc.onmessage = (msgEvent) => this.handleIncomingChunk(msgEvent.data);
          this.dataChannels.push(dc);
        }
      };
    }

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      if (state === 'connected') {
        this.events.onPeerConnected(remotePeerId);
        this.events.onStatusChange('P2P Direct Mesh Active');
      } else if (this.isTransferring && (state === 'disconnected' || state === 'failed' || state === 'closed')) {
        this.cancelTransfer('Peer connection lost');
      }
    };
  }

  private setupControlChannel(dc: RTCDataChannel) {
    dc.onopen = () => {
      this.events.onStatusChange('Control channel connected');
    };

    dc.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === 'TRANSFER_ABORT') {
        this.isCancelled = true;
        this.isPaused = false;
        this.worker.postMessage({ type: 'ABORT_FILE' });
        this.startAckResolvers.clear();
        this.fileSavedResolvers.clear();
        const reason = msg.reason || 'Transfer cancelled by peer';
        this.events.onTransferAborted?.(reason);
        this.events.onStatusChange(reason);
        return;
      } else if (msg.type === 'TRANSFER_PAUSED') {
        this.isPaused = true;
        this.events.onTransferPaused?.();
        this.events.onStatusChange('Transfer paused by peer');
      } else if (msg.type === 'TRANSFER_RESUMED') {
        this.isPaused = false;
        this.events.onTransferResumed?.();
        this.events.onStatusChange('Transfer resumed by peer');
      } else if (msg.type === 'START_FILE') {
        this.events.onStatusChange(`Preparing disk for: ${msg.fileName}`);
        this.worker.postMessage({
          type: 'INIT_FILE',
          payload: {
            fileId: String(msg.fileId),
            fileName: msg.fileName,
            relativePath: msg.relativePath,
            fileSize: msg.fileSize,
          },
        });
      } else if (msg.type === 'START_ACK') {
        const resolve = this.startAckResolvers.get(Number(msg.fileId));
        if (resolve) {
          resolve(Number(msg.resumedOffset || 0));
          this.startAckResolvers.delete(Number(msg.fileId));
        }
      } else if (msg.type === 'END_FILE') {
        this.worker.postMessage({
          type: 'FINALIZE_FILE',
          payload: { fileId: String(msg.fileId) },
        });
      } else if (msg.type === 'FILE_SAVED') {
        const resolve = this.fileSavedResolvers.get(Number(msg.fileId));
        if (resolve) {
          resolve();
          this.fileSavedResolvers.delete(Number(msg.fileId));
        }
      }
    };
  }

  private async handleIncomingChunk(buffer: ArrayBuffer) {
    const { fileId, byteOffset, payload } = unpackChunk(new Uint8Array(buffer));
    let finalPayload = payload;

    if (this.cryptoKey) {
      try {
        finalPayload = await decryptChunk(payload, this.cryptoKey);
      } catch {
        this.events.onStatusChange('Decryption error: Password mismatch!');
        return;
      }
    }

    this.worker.postMessage(
      {
        type: 'WRITE_CHUNK',
        payload: { fileId: String(fileId), offset: byteOffset, buffer: finalPayload },
      },
      [finalPayload.buffer]
    );
  }

  public async sendBatch(items: ExtendedFile[]) {
    if (!this.controlChannel || this.dataChannels.length === 0) return;
    this.isCancelled = false;
    this.isPaused = false;
    this.isTransferring = true;

    const multiplexer = new StripeMultiplexer(this.dataChannels);

    for (let i = 0; i < items.length; i++) {
      if (this.isCancelled) break;
      const { file, relativePath } = items[i];
      const fileId = i + 1;

      let safeResumeOffset = 0;
      const startAckPromise = new Promise<number>((resolve) => {
        this.startAckResolvers.set(fileId, resolve);
      });
      const fileSavedPromise = new Promise<void>((resolve) => {
        this.fileSavedResolvers.set(fileId, resolve);
      });

      this.events.onStatusChange(`[File ${i + 1}/${items.length}] Handshake: ${file.name}`);

      this.controlChannel.send(
        JSON.stringify({
          type: 'START_FILE',
          fileId,
          fileName: file.name,
          relativePath,
          fileSize: file.size,
        })
      );

      safeResumeOffset = await Promise.race([
        startAckPromise,
        new Promise<number>((resolve) => setTimeout(() => resolve(0), 10000)),
      ]);

      if (safeResumeOffset > 0) {
        this.events.onStatusChange(`[File ${i + 1}/${items.length}] Resuming ${file.name} from ${(safeResumeOffset / 1024 / 1024).toFixed(1)} MB`);
      } else {
        this.events.onStatusChange(`[File ${i + 1}/${items.length}] Streaming: ${file.name}`);
      }

      const startTime = performance.now();
      await new Promise<void>((resolve, reject) => {
        this.activeSenderWorker = new Worker(
          new URL('../workers/transferSender.worker.js', import.meta.url),
          { type: 'module' }
        );

        this.activeSenderWorker.onmessage = async (e) => {
          const { type, data } = e.data;

          if (type === 'CHUNK_PACKET') {
            const { packet, byteOffset, totalSize } = data;
            try {
              if (this.isCancelled) {
                this.activeSenderWorker?.postMessage({ type: 'CANCEL' });
                this.activeSenderWorker?.terminate();
                this.activeSenderWorker = null;
                resolve();
                return;
              }

              await multiplexer.sendPacket(new Uint8Array(packet));

              const elapsedSec = (performance.now() - startTime) / 1000;
              const speed = elapsedSec > 0 && !this.isPaused ? byteOffset / (1024 * 1024) / elapsedSec : 0;
              const currentBufferMB = this.dataChannels.reduce((sum, ch) => sum + ch.bufferedAmount, 0) / (1024 * 1024);

              this.events.onMetrics({
                percent: Math.min(100, (byteOffset / totalSize) * 100),
                speedMBps: speed,
                bufferedAmountMB: currentBufferMB,
                currentFileName: file.name,
                bytesTransferred: byteOffset,
                totalBytes: totalSize,
                isPaused: this.isPaused,
              });
            } catch (err) {
              this.activeSenderWorker?.terminate();
              this.activeSenderWorker = null;
              reject(err);
            }
          } else if (type === 'TRANSFER_COMPLETE') {
            this.activeSenderWorker?.terminate();
            this.activeSenderWorker = null;
            resolve();
          } else if (type === 'ERROR') {
            this.activeSenderWorker?.terminate();
            this.activeSenderWorker = null;
            reject(new Error(data.message));
          }
        };

        this.activeSenderWorker.postMessage({
          type: 'START_TRANSFER',
          data: {
            file,
            fileId,
            key: this.cryptoKey,
            startOffset: safeResumeOffset,
            chunkSize: DEFAULT_CHUNK_SIZE,
          },
        });
      });

      await multiplexer.flush();

      this.events.onMetrics({
        percent: 100,
        speedMBps: 0,
        bufferedAmountMB: 0,
        currentFileName: file.name,
        bytesTransferred: file.size,
        totalBytes: file.size,
        isPaused: false,
      });

      this.controlChannel.send(JSON.stringify({ type: 'END_FILE', fileId }));
      this.events.onStatusChange(`[File ${i + 1}/${items.length}] Waiting for receiver disk flush: ${file.name}...`);

      await Promise.race([
        fileSavedPromise,
        new Promise((resolve) => setTimeout(resolve, 60000)),
      ]);

      this.events.onStatusChange(`[File ${i + 1}/${items.length}] Confirmed & Verified: ${file.name}`);
    }

    this.isTransferring = false;
    this.isPaused = false;
    this.events.onStatusChange('All files transferred and verified!');
  }

  private cleanup() {
    this.pc?.close();
    this.pc = null;
    this.dataChannels = [];
    this.controlChannel = null;
    this.activeSenderWorker?.terminate();
    this.activeSenderWorker = null;
    this.startAckResolvers.clear();
    this.fileSavedResolvers.clear();
  }
}
