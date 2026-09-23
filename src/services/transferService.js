import { StripeMultiplexer } from '../engine/stripeMultiplexer.js';

export class TransferService {
  constructor() {
    this.senderWorker = null;
    this.receiverWorker = null;
    this.multiplexer = null;
    this.onProgress = null;
    this.onComplete = null;
    this.onError = null;
  }

  /**
   * Initializes sender pipeline across active WebRTC data channels.
   * @param {File} file
   * @param {number} fileId
   * @param {RTCDataChannel[]} channels
   * @param {CryptoKey|null} [key]
   * @param {number} [startOffset=0]
   */
  async startSending(file, fileId, channels, key = null, startOffset = 0) {
    this.multiplexer = new StripeMultiplexer(channels);

    this.senderWorker = new Worker(
      new URL('../workers/transferSender.worker.js', import.meta.url),
      { type: 'module' }
    );

    this.senderWorker.onmessage = async (e) => {
      const { type, data } = e.data;

      if (type === 'CHUNK_PACKET') {
        const { packet, byteOffset, totalSize } = data;
        try {
          await this.multiplexer.sendPacket(packet);
          if (this.onProgress) {
            this.onProgress({ byteOffset, totalBytes: totalSize });
          }
        } catch (err) {
          if (this.onError) this.onError(err);
        }
      } else if (type === 'TRANSFER_COMPLETE') {
        await this.multiplexer.flush();
        if (this.onComplete) this.onComplete(data);
      } else if (type === 'ERROR') {
        if (this.onError) this.onError(new Error(data.message));
      }
    };

    this.senderWorker.postMessage({
      type: 'START_TRANSFER',
      data: { file, fileId, key, startOffset }
    });
  }

  /**
   * Initializes receiver pipeline using OPFS background worker.
   * @param {string} fileName
   * @param {number} totalSize
   * @param {RTCDataChannel[]} channels
   * @param {CryptoKey|null} [key]
   */
  async startReceiving(fileName, totalSize, channels, key = null) {
    this.receiverWorker = new Worker(
      new URL('../workers/transferReceiver.worker.js', import.meta.url),
      { type: 'module' }
    );

    return new Promise((resolve, reject) => {
      this.receiverWorker.onmessage = (e) => {
        const { type, data } = e.data;

        if (type === 'INITIALIZED') {
          // Attach listeners to incoming data channels
          for (const channel of channels) {
            channel.binaryType = 'arraybuffer';
            channel.onmessage = (msgEvent) => {
              const packet = new Uint8Array(msgEvent.data);
              this.receiverWorker.postMessage(
                { type: 'WRITE_PACKET', data: { packet } },
                [packet.buffer]
              );
            };
          }
          resolve();
        } else if (type === 'PROGRESS') {
          if (this.onProgress) this.onProgress(data);
        } else if (type === 'COMPLETED') {
          if (this.onComplete) this.onComplete(data.file);
        } else if (type === 'ERROR') {
          if (this.onError) this.onError(new Error(data.message));
          reject(new Error(data.message));
        }
      };

      this.receiverWorker.postMessage({
        type: 'INIT',
        data: { fileName, totalSize, key }
      });
    });
  }

  /**
   * Signals receiver worker to flush and finalize the file handle.
   */
  finalizeReceiving() {
    if (this.receiverWorker) {
      this.receiverWorker.postMessage({ type: 'FINALIZE' });
    }
  }

  /**
   * Cleans up all active workers.
   */
  terminate() {
    if (this.senderWorker) {
      this.senderWorker.terminate();
      this.senderWorker = null;
    }
    if (this.receiverWorker) {
      this.receiverWorker.terminate();
      this.receiverWorker = null;
    }
    this.multiplexer = null;
  }
}
