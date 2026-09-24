/**
 * DropLink2 End-to-End Encryption (E2EE) Module
 * Implements PBKDF2 key derivation (100,000 iterations, SHA-256) and AES-256-GCM chunk encryption.
 */

export async function deriveRoomKey(password: string, roomId: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(`droplink-e2ee-salt-${roomId}`),
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptChunk(data: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  const result = new Uint8Array(iv.byteLength + encryptedBuffer.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encryptedBuffer), iv.byteLength);
  return result.buffer;
}

export async function decryptChunk(encryptedData: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const uint8 = new Uint8Array(encryptedData);
  if (uint8.byteLength < 12) {
    throw new Error('Encrypted payload too short: missing 12-byte IV header');
  }

  const iv = uint8.slice(0, 12);
  const ciphertext = uint8.slice(12);

  return await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
}