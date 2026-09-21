export async function computeFileSHA256(fileBlob: Blob): Promise<string> {
  const stream = fileBlob.stream();
  const reader = stream.getReader();
  const digestStream = new SubtleCryptoDigest();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    digestStream.update(value);
  }

  return digestStream.finalizeHex();
}

class SubtleCryptoDigest {
  private chunks: Uint8Array[] = [];

  update(chunk: Uint8Array) {
    this.chunks.push(chunk);
  }

  async finalizeHex(): Promise<string> {
    const merged = new Uint8Array(this.chunks.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const c of this.chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    const hashBuffer = await crypto.subtle.digest('SHA-256', merged);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}