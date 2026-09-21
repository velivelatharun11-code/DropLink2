export interface StoredFileEntry {
  name: string;
  size: number;
}

export async function listOPFSFiles(): Promise<StoredFileEntry[]> {
  const files: StoredFileEntry[] = [];
  try {
    const root = await navigator.storage.getDirectory();
    // @ts-ignore - async iterator for FileSystemDirectoryHandle
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile();
        files.push({ name, size: file.size });
      }
    }
  } catch (err) {
    console.warn('Failed to query OPFS directory:', err);
  }
  return files;
}

export async function purgeOPFSEntry(name: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(name);
}

export async function purgeAllOPFS(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  // @ts-ignore
  for await (const [name] of root.entries()) {
    await root.removeEntry(name);
  }
}