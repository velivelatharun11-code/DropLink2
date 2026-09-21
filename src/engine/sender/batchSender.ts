import type { ControlMessage } from '../../types/protocol';
import { sendChunkWithBackpressure } from './channelStreamer';

export class BatchSender {
  private controlChannel: RTCDataChannel;
  private dataChannel: RTCDataChannel;
  private CHUNK_SIZE = 64 * 1024; // 64 KB slices

  constructor(controlChannel: RTCDataChannel, dataChannel: RTCDataChannel) {
    this.controlChannel = controlChannel;
    this.dataChannel = dataChannel;
  }

  public async sendBatch(files: File[]): Promise<void> {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileId = `file-${i}-${Date.now()}`;

      // 1. Calculate Expected SHA-256
      const arrayBuffer = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
      const expectedHash = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      // 2. Announce File Start to Receiver
      const startMsg: ControlMessage = {
        type: 'FILE_START',
        fileId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        chunkSize: this.CHUNK_SIZE,
        totalChunks: Math.ceil(file.size / this.CHUNK_SIZE),
        expectedHash
      };
      this.controlChannel.send(JSON.stringify(startMsg));

      // 3. Slice and Stream Data Chunks with Backpressure
      let offset = 0;
      while (offset < file.size) {
        const slice = arrayBuffer.slice(offset, offset + this.CHUNK_SIZE);
        await sendChunkWithBackpressure(this.dataChannel, slice);
        offset += slice.byteLength;
      }

      // 4. Notify Receiver that all chunks are sent
      const endMsg: ControlMessage = { type: 'FILE_END', fileId };
      this.controlChannel.send(JSON.stringify(endMsg));

      // 5. PAUSE here and wait for explicit Receiver confirmation from OPFS
      await this.waitForReceiverAck(fileId, file.name);
    }

    // All files acknowledged successfully
    this.controlChannel.send(JSON.stringify({ type: 'BATCH_COMPLETE' }));
  }

  private waitForReceiverAck(fileId: string, fileName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.controlChannel.removeEventListener('message', handleAck);
        reject(new Error(`Timeout waiting for OPFS flush ACK for: ${fileName}`));
      }, 60000);

      const handleAck = (event: MessageEvent) => {
        try {
          const msg: ControlMessage = JSON.parse(event.data);
          if (msg.type === 'FILE_ACK' && msg.fileId === fileId) {
            clearTimeout(timeout);
            this.controlChannel.removeEventListener('message', handleAck);

            if (msg.status === 'SUCCESS') {
              resolve();
            } else {
              reject(new Error(`Corrupted file [${fileName}]: ${msg.error}`));
            }
          }
        } catch {
          // Ignore non-JSON traffic
        }
      };

      this.controlChannel.addEventListener('message', handleAck);
    });
  }
}
