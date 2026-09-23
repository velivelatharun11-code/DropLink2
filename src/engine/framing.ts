export const HEADER_SIZE = 16;
export const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KB

export interface UnpackedChunk {
  fileId: number;
  chunkIndex: number;
  byteOffset: number;
  length: number;
  payload: Uint8Array;
}

export function packChunk(
  fileId: number,
  chunkIndex: number,
  byteOffset: number,
  payloadUint8: Uint8Array
): Uint8Array {
  const packet = new Uint8Array(HEADER_SIZE + payloadUint8.byteLength);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

  view.setUint32(0, fileId, false);
  view.setUint32(4, chunkIndex, false);
  view.setUint32(8, byteOffset, false);
  view.setUint32(12, payloadUint8.byteLength, false);

  packet.set(payloadUint8, HEADER_SIZE);
  return packet;
}

export function unpackChunk(packetUint8: Uint8Array): UnpackedChunk {
  if (packetUint8.byteLength < HEADER_SIZE) {
    throw new Error('MalformedPacket: Buffer shorter than header size');
  }

  const view = new DataView(packetUint8.buffer, packetUint8.byteOffset, packetUint8.byteLength);
  const fileId = view.getUint32(0, false);
  const chunkIndex = view.getUint32(4, false);
  const byteOffset = view.getUint32(8, false);
  const length = view.getUint32(12, false);

  if (packetUint8.byteLength < HEADER_SIZE + length) {
    throw new Error('MalformedPacket: Packet truncated before expected payload length');
  }

  const payload = packetUint8.subarray(HEADER_SIZE, HEADER_SIZE + length);
  return { fileId, chunkIndex, byteOffset, length, payload };
}
