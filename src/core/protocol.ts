/**
 * DropLink2 Binary Framing Protocol
 * Header Size: 16 Bytes
 * 
 * Byte Structure:
 * [0..3]   : File ID (Uint32, Big-Endian)
 * [4..7]   : Chunk Index (Uint32, Big-Endian)
 * [8..11]  : Byte Offset (Uint32, Big-Endian)
 * [12..15] : Payload Length (Uint32, Big-Endian)
 * [16..N]  : Raw File Chunk Bytes
 */

export const HEADER_SIZE = 16;
export const CHUNK_SIZE = 64 * 1024; // 64 KB per SCTP packet

export interface UnpackedPacket {
  fileId: number;
  chunkIndex: number;
  byteOffset: number;
  length: number;
  payload: ArrayBuffer;
}

export interface FileMetadata {
  fileId: number;
  fileName: string;
  relativePath: string;
  fileSize: number;
  totalFiles?: number;
}

/**
 * Packs metadata and payload slice into a single ArrayBuffer.
 */
export function packChunk(
  fileId: number,
  chunkIndex: number,
  byteOffset: number,
  payload: ArrayBuffer
): ArrayBuffer {
  const packet = new Uint8Array(HEADER_SIZE + payload.byteLength);
  const view = new DataView(packet.buffer);

  view.setUint32(0, fileId, false);
  view.setUint32(4, chunkIndex, false);
  view.setUint32(8, byteOffset, false);
  view.setUint32(12, payload.byteLength, false);

  packet.set(new Uint8Array(payload), HEADER_SIZE);
  return packet.buffer;
}

/**
 * Unpacks packet metadata and payload slice.
 */
export function unpackChunk(packetBuffer: ArrayBuffer): UnpackedPacket {
  const view = new DataView(packetBuffer);

  const fileId = view.getUint32(0, false);
  const chunkIndex = view.getUint32(4, false);
  const byteOffset = view.getUint32(8, false);
  const length = view.getUint32(12, false);

  const payload = packetBuffer.slice(HEADER_SIZE, HEADER_SIZE + length);

  return {
    fileId,
    chunkIndex,
    byteOffset,
    length,
    payload,
  };
}