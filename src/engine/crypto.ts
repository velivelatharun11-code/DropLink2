function getCrypto(): Crypto {
  if (typeof globalThis !== 'undefined' && globalThis.crypto) {
    return globalThis.crypto;
  }
  throw new Error('WebCryptoAPIUnavailable');
}

export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const cryptoObj = getCrypto();
  const enc = new TextEncoder();
  const rawKey = await cryptoObj.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return cryptoObj.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new Uint8Array(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    rawKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptChunk(rawChunk: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const cryptoObj = getCrypto();
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await cryptoObj.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv,
      tagLength: 128,
    },
    key,
    new Uint8Array(rawChunk)
  );

  const encryptedChunk = new Uint8Array(iv.byteLength + ciphertextBuffer.byteLength);
  encryptedChunk.set(iv, 0);
  encryptedChunk.set(new Uint8Array(ciphertextBuffer), iv.byteLength);
  return encryptedChunk;
}

export async function decryptChunk(encChunk: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  if (encChunk.byteLength < 28) {
    throw new Error('CiphertextTooShort: Missing IV or GCM authentication tag');
  }

  const cryptoObj = getCrypto();
  const iv = new Uint8Array(encChunk.buffer, encChunk.byteOffset, 12);
  const data = new Uint8Array(encChunk.buffer, encChunk.byteOffset + 12, encChunk.byteLength - 12);

  const decryptedBuffer = await cryptoObj.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv as unknown as BufferSource,
      tagLength: 128,
    },
    key,
    data as unknown as BufferSource
  );

  return new Uint8Array(decryptedBuffer);
}
