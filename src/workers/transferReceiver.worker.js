import { unpackChunk } from '../engine/framing.js';
import { decryptChunk } from '../engine/crypto.js';
import { OPFSWriter } from '../engine/opfsWriter.js';

let writer = null;
let decryptionKey = null;
let expectedSize = 0;
let receivedBytes = 0;

self.onmessage = async (e) => {
  const { type, data } = e.data;

  try {
    switch (type) {
      case 'INIT': {
        const { fileName, totalSize, key } = data;
        expectedSize = totalSize;
        decryptionKey = key;
        receivedBytes = 0;

        writer = new OPFSWriter(fileName, totalSize);
        await writer.init();

        self.postMessage({ type: 'INITIALIZED' });
        break;
      }

      case 'WRITE_PACKET': {
        if (!writer) throw new Error('WorkerWriterNotReady');

        const { packet } = data;
        const { byteOffset, payload } = unpackChunk(packet);

        let finalPayload = payload;
        if (decryptionKey) {
          finalPayload = await decryptChunk(payload, decryptionKey);
        }

        await writer.writeChunk(finalPayload, byteOffset);
        receivedBytes += finalPayload.byteLength;

        self.postMessage({
          type: 'PROGRESS',
          data: {
            receivedBytes,
            totalBytes: expectedSize,
            byteOffset,
          },
        });
        break;
      }

      case 'GET_SAFE_RESUME_OFFSET': {
        const { chunkSize } = data;
        const safeOffset = writer ? writer.getSafeResumeOffset(chunkSize) : 0;
        self.postMessage({
          type: 'SAFE_RESUME_OFFSET',
          data: { safeOffset },
        });
        break;
      }

      case 'FINALIZE': {
        if (writer) {
          await writer.finalize();
          const file = await writer.getFile();
          self.postMessage({
            type: 'COMPLETED',
            data: { file },
          });
        }
        break;
      }

      default:
        console.warn('Unhandled worker message type:', type);
    }
  } catch (err) {
    self.postMessage({
      type: 'ERROR',
      data: { message: err.message },
    });
  }
};
