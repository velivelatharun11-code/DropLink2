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

// Alias for workers expecting deriveRoomKey
export const deriveRoomKey = deriveKeyFromPassword;

// Supports both (key, data) and (data, key) calling signatures
export async function encryptChunk(
  arg1: CryptoKey | ArrayBuffer,
  arg2: CryptoKey | ArrayBuffer
): Promise<ArrayBuffer> {
  const key = (arg1 instanceof CryptoKey ? arg1 : arg2) as CryptoKey;
  const data = (arg1 instanceof ArrayBuffer ? arg1 : arg2) as ArrayBuffer;

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result.buffer;
}

// Supports both (key, encryptedData) and (encryptedData, key) calling signatures
export async function decryptChunk(
  arg1: CryptoKey | ArrayBuffer,
  arg2: CryptoKey | ArrayBuffer
): Promise<ArrayBuffer> {
  const key = (arg1 instanceof CryptoKey ? arg1 : arg2) as CryptoKey;
  const encryptedData = (arg1 instanceof ArrayBuffer ? arg1 : arg2) as ArrayBuffer;

  const dataView = new Uint8Array(encryptedData);
  const iv = dataView.slice(0, 12);
  const ciphertext = dataView.slice(12);

  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
}