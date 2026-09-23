// OPFS SyncAccessHandle Web Worker Type Definitions
interface FileSystemSyncAccessHandle {
  close(): void;
  flush(): void;
  getSize(): number;
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
}

export interface InitPayload {
  fileId: string;
  fileName: string;
  relativePath?: string;
  fileSize: number;
}

export interface WritePayload {
  fileId: string;
  offset: number;
  buffer: ArrayBuffer;
}

interface ActiveFile {
  fileHandle: FileSystemFileHandle;
  accessHandle: FileSystemSyncAccessHandle;
  fileName: string;
  relativePath: string;
  fileSize: number;
  bytesWritten: number;
  unflushedBytes: number;
}

const CHUNK_SIZE = 64 * 1024;
const FLUSH_INTERVAL = 1024 * 1024; // 1 MB periodic flush
const activeFiles = new Map<string, ActiveFile>();

async function getNestedFileHandle(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop()!;
  let currentDir = root;

  for (const part of parts) {
    currentDir = await currentDir.getDirectoryHandle(part, { create: true });
  }

  return await currentDir.getFileHandle(fileName, { create: true });
}

async function computeFileHashStreaming(file: File): Promise<string> {
  const HASH_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB slices

  if (file.size <= 32 * 1024 * 1024) {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  const headSlice = await file.slice(0, HASH_CHUNK_SIZE).arrayBuffer();
  const tailSlice = await file.slice(Math.max(0, file.size - HASH_CHUNK_SIZE)).arrayBuffer();
  const combined = new Uint8Array(headSlice.byteLength + tailSlice.byteLength);
  combined.set(new Uint8Array(headSlice), 0);
  combined.set(new Uint8Array(tailSlice), headSlice.byteLength);

  const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  switch (type) {
    case 'INIT_FILE': {
      const { fileId, fileName, relativePath, fileSize } = payload as InitPayload;
      try {
        const root = await navigator.storage.getDirectory();
        const filePath = relativePath || fileName;
        const fileHandle = await getNestedFileHandle(root, filePath);

        const accessHandle = (await (fileHandle as any).createSyncAccessHandle()) as FileSystemSyncAccessHandle;

        const existingSize = accessHandle.getSize();
        let resumedOffset = 0;

        if (existingSize > 0 && existingSize < fileSize) {
          resumedOffset = Math.floor(existingSize / CHUNK_SIZE) * CHUNK_SIZE;
          accessHandle.truncate(resumedOffset);
        } else {
          accessHandle.truncate(0);
          resumedOffset = 0;
        }

        activeFiles.set(fileId, {
          fileHandle,
          accessHandle,
          fileName,
          relativePath: filePath,
          fileSize,
          bytesWritten: resumedOffset,
          unflushedBytes: 0,
        });

        self.postMessage({ type: 'FILE_INITIALIZED', fileId, resumedOffset });
      } catch (err: any) {
        self.postMessage({ type: 'ERROR', fileId, error: err.message });
      }
      break;
    }

    case 'WRITE_CHUNK': {
      const { fileId, offset, buffer } = payload as WritePayload;
      const target = activeFiles.get(fileId);
      if (!target) return;

      const uint8 = new Uint8Array(buffer);
      target.accessHandle.write(uint8, { at: offset });
      target.bytesWritten += uint8.byteLength;
      target.unflushedBytes += uint8.byteLength;

      if (target.unflushedBytes >= FLUSH_INTERVAL) {
        target.accessHandle.flush();
        target.unflushedBytes = 0;
      }

      self.postMessage({
        type: 'WRITE_PROGRESS',
        fileId,
        fileName: target.fileName,
        relativePath: target.relativePath,
        bytesWritten: target.bytesWritten,
        fileSize: target.fileSize,
      });
      break;
    }

    case 'FINALIZE_FILE': {
      const { fileId } = payload;
      const target = activeFiles.get(fileId);
      if (!target) return;

      // Ensure 100% progress event is dispatched
      self.postMessage({
        type: 'WRITE_PROGRESS',
        fileId,
        fileName: target.fileName,
        relativePath: target.relativePath,
        bytesWritten: target.fileSize,
        fileSize: target.fileSize,
      });

      target.accessHandle.truncate(target.fileSize);
      target.accessHandle.flush();
      target.accessHandle.close();

      const blob = await target.fileHandle.getFile();
      const meta = {
        fileName: target.fileName,
        relativePath: target.relativePath,
      };

      let checksum = '';
      try {
        checksum = await computeFileHashStreaming(blob);
      } catch (err) {
        console.warn('Checksum calculation failed:', err);
      }

      activeFiles.delete(fileId);

      self.postMessage({
        type: 'FILE_COMPLETE',
        fileId,
        fileName: meta.fileName,
        relativePath: meta.relativePath,
        checksum,
        file: blob,
      });
      break;
    }

    case 'ABORT_FILE': {
      for (const [, target] of activeFiles.entries()) {
        try {
          target.accessHandle.close();
        } catch {}
      }
      activeFiles.clear();
      self.postMessage({ type: 'FILE_ABORTED' });
      break;
    }
  }
};
