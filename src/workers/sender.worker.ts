import { packChunk } from '../protocol/frame';
import { deriveRoomKey, encryptChunk } from '../protocol/crypto';

let activeStream = false;
let currentOffset = 0;
let chunkSize = 128 * 1024;
let activeFile: File | null = null;
let currentFileId = 0;
let cryptoKey: CryptoKey | null = null;
const fileQueue: { file: File; fileId: number }[] = [];

async function streamNextFile() {
  if (fileQueue.length === 0) {
    activeStream = false;
    self.postMessage({ type: 'ALL_TRANSFERS_COMPLETE' });
    return;
  }

  activeStream = true;
  const item = fileQueue.shift()!;
  activeFile = item.file;
  currentFileId = item.fileId;
  currentOffset = 0;
  const totalSize = activeFile.size;

  self.postMessage({
    type: 'FILE_STREAM_START',
    fileId: currentFileId,
    fileName: activeFile.name,
    fileSize: totalSize,
  });

  while (activeStream && currentOffset < totalSize) {
    const sliceEnd = Math.min(currentOffset + chunkSize, totalSize);
    const rawSlice = activeFile.slice(currentOffset, sliceEnd);
    let payloadBuffer = await rawSlice.arrayBuffer();

    // Hardware-accelerated AES-GCM encryption in Worker
    if (cryptoKey) {
      payloadBuffer = await encryptChunk(cryptoKey, payloadBuffer);
    }

    const framedBuffer = packChunk(currentFileId, currentOffset, payloadBuffer);

    (self.postMessage as (message: any, transfer: Transferable[]) => void)(
      {
        type: 'CHUNK_READY',
        buffer: framedBuffer,
        fileId: currentFileId,
        offset: currentOffset,
        bytesSent: sliceEnd,
        totalSize,
      },
      [framedBuffer]
    );

    currentOffset = sliceEnd;
  }

  if (currentOffset >= totalSize) {
    self.postMessage({
      type: 'FILE_STREAM_COMPLETE',
      fileId: currentFileId,
      fileName: activeFile.name,
      totalSize,
    });
    await streamNextFile();
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { type, file, files, fileId, newChunkSize, missingChunks, roomCode } = e.data;

  if (type === 'INIT_CRYPTO' && roomCode) {
    cryptoKey = await deriveRoomKey(roomCode);
    return;
  }

  if (type === 'ADJUST_CHUNK_SIZE' && newChunkSize) {
    chunkSize = newChunkSize;
    return;
  }

  if (type === 'ENQUEUE_FILES' && Array.isArray(files)) {
    files.forEach((f: File, idx: number) => {
      fileQueue.push({ file: f, fileId: Date.now() + idx });
    });

    if (!activeStream) {
      await streamNextFile();
    }
  }

  if (type === 'START_STREAM' && file) {
    fileQueue.push({ file, fileId: fileId || Date.now() });
    if (!activeStream) {
      await streamNextFile();
    }
  }

  if (type === 'RESEND_CHUNKS' && activeFile && Array.isArray(missingChunks)) {
    for (const chunkIndex of missingChunks) {
      const offset = chunkIndex * chunkSize;
      const sliceEnd = Math.min(offset + chunkSize, activeFile.size);
      const rawSlice = activeFile.slice(offset, sliceEnd);
      let payloadBuffer = await rawSlice.arrayBuffer();

      if (cryptoKey) {
        payloadBuffer = await encryptChunk(cryptoKey, payloadBuffer);
      }

      const framedBuffer = packChunk(currentFileId, offset, payloadBuffer);

      (self.postMessage as (message: any, transfer: Transferable[]) => void)(
        {
          type: 'CHUNK_READY',
          buffer: framedBuffer,
          fileId: currentFileId,
          offset,
          bytesSent: offset,
          totalSize: activeFile.size,
        },
        [framedBuffer]
      );
    }
  }

  if (type === 'STOP_STREAM') {
    activeStream = false;
    fileQueue.length = 0;
  }
};