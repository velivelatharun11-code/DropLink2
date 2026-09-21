// CRC32 table initialization
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// 20-byte Frame Header:
// [0..3]:   fileId (uint32)
// [4..11]:  byteOffset (uint64 BigInt)
// [12..15]: payloadLength (uint32)
// [16..19]: crc32Checksum (uint32)

export function packChunk(fileId: number, byteOffset: number, payload: ArrayBuffer): ArrayBuffer {
  const headerSize = 20;
  const totalLength = headerSize + payload.byteLength;
  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const uint8View = new Uint8Array(buffer);

  const payloadUint8 = new Uint8Array(payload);
  const checksum = crc32(payloadUint8);

  view.setUint32(0, fileId, false);
  view.setBigUint64(4, BigInt(byteOffset), false);
  view.setUint32(12, payload.byteLength, false);
  view.setUint32(16, checksum, false);

  uint8View.set(payloadUint8, headerSize);
  return buffer;
}

export function unpackChunk(buffer: ArrayBuffer): {
  fileId: number;
  byteOffset: number;
  payload: ArrayBuffer;
  valid: boolean;
} {
  const view = new DataView(buffer);
  const fileId = view.getUint32(0, false);
  const byteOffset = Number(view.getBigUint64(4, false));
  const payloadLength = view.getUint32(12, false);
  const expectedCrc = view.getUint32(16, false);

  const payload = buffer.slice(20, 20 + payloadLength);
  const actualCrc = crc32(new Uint8Array(payload));

  return {
    fileId,
    byteOffset,
    payload,
    valid: actualCrc === expectedCrc
  };
}

export function createBitmask(totalChunks: number): Uint8Array {
  return new Uint8Array(Math.ceil(totalChunks / 8));
}

export function setBitmaskChunk(bitmask: Uint8Array, chunkIndex: number): void {
  const byteIdx = Math.floor(chunkIndex / 8);
  const bitOffset = chunkIndex % 8;
  bitmask[byteIdx] |= (1 << bitOffset);
}

export function isBitmaskChunkSet(bitmask: Uint8Array, chunkIndex: number): boolean {
  const byteIdx = Math.floor(chunkIndex / 8);
  const bitOffset = chunkIndex % 8;
  return (bitmask[byteIdx] & (1 << bitOffset)) !== 0;
}

export function getMissingChunks(bitmask: Uint8Array, totalChunks: number): number[] {
  const missing: number[] = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!isBitmaskChunkSet(bitmask, i)) {
      missing.push(i);
    }
  }
  return missing;
}