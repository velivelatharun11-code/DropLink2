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
}

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

async function computeFileHash(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
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
        
        const accessHandle = await (fileHandle as any).createSyncAccessHandle() as FileSystemSyncAccessHandle;
        
        // Truncate to 0 bytes so no stale data from prior transfers remains
        accessHandle.truncate(0);

        activeFiles.set(fileId, {
          fileHandle,
          accessHandle,
          fileName,
          relativePath: filePath,
          fileSize,
          bytesWritten: 0,
        });

        // Notify main thread that handle is initialized and ready
        self.postMessage({ type: 'FILE_INITIALIZED', fileId });
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
      // Write directly at the designated byte offset
      target.accessHandle.write(uint8, { at: offset });
      target.bytesWritten += uint8.byteLength;

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

      // Ensure exact file size on disk before flushing
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
        checksum = await computeFileHash(blob);
      } catch (err) {
        console.warn('Checksum failed:', err);
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
  }
};