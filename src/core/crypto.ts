// WebCrypto PBKDF2 + AES-GCM-256 zero-dependency encryption

const PBKDF2_SALT = new TextEncoder().encode('droplink2-salt-mesh');
const PBKDF2_ITERATIONS = 100_000;

export async function deriveKeyFromPassword(password: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: PBKDF2_SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptChunk(data: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  // 12-byte initialization vector for AES-GCM
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  // Prepend 12-byte IV directly to ciphertext
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result.buffer;
}

export async function decryptChunk(encryptedData: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const dataView = new Uint8Array(encryptedData);
  const iv = dataView.slice(0, 12);
  const ciphertext = dataView.slice(12);

  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
}