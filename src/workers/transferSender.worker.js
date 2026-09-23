import { packChunk, DEFAULT_CHUNK_SIZE } from '../engine/framing.js';
import { encryptChunk } from '../engine/crypto.js';

let isPaused = false;
let isCancelled = false;

self.onmessage = async (e) => {
  const { type, data } = e.data;

  try {
    switch (type) {
      case 'START_TRANSFER': {
        const { file, fileId, key, startOffset = 0, chunkSize = DEFAULT_CHUNK_SIZE } = data;
        isPaused = false;
        isCancelled = false;

        const totalSize = file.size;
        let byteOffset = startOffset;
        let chunkIndex = Math.floor(startOffset / chunkSize);

        self.postMessage({
          type: 'TRANSFER_STARTED',
          data: { fileId, startOffset, totalSize }
        });

        while (byteOffset < totalSize) {
          if (isCancelled) {
            self.postMessage({ type: 'TRANSFER_CANCELLED' });
            return;
          }

          while (isPaused) {
            await new Promise((res) => setTimeout(res, 50));
            if (isCancelled) return;
          }

          const currentSliceSize = Math.min(chunkSize, totalSize - byteOffset);
          const sliceBlob = file.slice(byteOffset, byteOffset + currentSliceSize);
          const rawBuffer = await sliceBlob.arrayBuffer();

          let payload = new Uint8Array(rawBuffer);
          if (key) {
            payload = await encryptChunk(payload, key);
          }

          const packet = packChunk(fileId, chunkIndex, byteOffset, payload);

          // Zero-copy transfer of packet buffer to main thread
          self.postMessage(
            {
              type: 'CHUNK_PACKET',
              data: {
                packet,
                chunkIndex,
                byteOffset,
                chunkSize: currentSliceSize,
                totalSize
              }
            },
            [packet.buffer]
          );

          byteOffset += currentSliceSize;
          chunkIndex++;
        }

        self.postMessage({ type: 'TRANSFER_COMPLETE', data: { fileId, totalSize } });
        break;
      }

      case 'PAUSE': {
        isPaused = true;
        self.postMessage({ type: 'TRANSFER_PAUSED' });
        break;
      }

      case 'RESUME': {
        isPaused = false;
        self.postMessage({ type: 'TRANSFER_RESUMED' });
        break;
      }

      case 'CANCEL': {
        isCancelled = true;
        break;
      }

      default:
        console.warn('Unhandled sender worker message:', type);
    }
  } catch (err) {
    self.postMessage({
      type: 'ERROR',
      data: { message: err.message }
    });
  }
};
