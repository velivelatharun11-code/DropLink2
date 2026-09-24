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
  fileSize?: number;
  mimeType?: string;
}

interface ActiveFile {
  fileHandle: FileSystemFileHandle;
  accessHandle: FileSystemSyncAccessHandle | null;
  sanitizedFileName: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  bytesWritten: number;
  unflushedBytes: number;
}

const FLUSH_INTERVAL = 1024 * 1024; // 1 MB periodic flush
const activeFiles = new Map<string, ActiveFile>();
let currentFileId: string | null = null;

function sanitizeFileName(rawPath: string): string {
  if (!rawPath) return 'unnamed_file';
  // Replace slashes and backslashes with double underscores for flat OPFS storage
  return rawPath.replace(/[/\\]+/g, '__').replace(/[^a-zA-Z0-9._-]/g, '_');
}

self.onmessage = async (e: MessageEvent) => {
  const data = e.data || {};
  // Support both wrapped payload format and direct flat format
  const type: string = data.type;
  const payload = data.payload || data;

  switch (type) {
    case 'INIT_FILE_STREAM':
    case 'INIT_FILE': {
      const fileId = payload.fileId || `file-${Date.now()}`;
      const rawName = payload.relativePath || payload.fileName || 'file';
      const sanitizedFileName = sanitizeFileName(rawName);
      const fileSize = payload.fileSize || 0;
      const mimeType = payload.mimeType || 'application/octet-stream';

      try {
        const root = await navigator.storage.getDirectory();
        const fileHandle = await root.getFileHandle(sanitizedFileName, { create: true });
        const accessHandle = (await (fileHandle as any).createSyncAccessHandle()) as FileSystemSyncAccessHandle;

        accessHandle.truncate(0);

        activeFiles.set(fileId, {
          fileHandle,
          accessHandle,
          sanitizedFileName,
          originalName: payload.fileName || rawName,
          fileSize,
          mimeType,
          bytesWritten: 0,
          unflushedBytes: 0,
        });

        currentFileId = fileId;

        self.postMessage({
          type: 'FILE_INITIALIZED',
          fileId,
          fileName: sanitizedFileName,
          originalName: payload.fileName || rawName
        });
      } catch (err: any) {
        console.error('[OPFS Worker] Failed to init file:', err);
        self.postMessage({ type: 'ERROR', fileId, error: err.message });
      }
      break;
    }

    case 'WRITE_CHUNK': {
      const fileId = payload.fileId || currentFileId;
      if (!fileId) return;

      const target = activeFiles.get(fileId);
      if (!target || !target.accessHandle) return;

      const rawBuffer: ArrayBuffer | undefined = payload.buffer || payload.chunk;
      if (!rawBuffer) return;

      const uint8 = new Uint8Array(rawBuffer);

      try {
        if (typeof payload.offset === 'number') {
          target.accessHandle.write(uint8, { at: payload.offset });
        } else {
          target.accessHandle.write(uint8, { at: target.bytesWritten });
        }

        target.bytesWritten += uint8.byteLength;
        target.unflushedBytes += uint8.byteLength;

        if (target.unflushedBytes >= FLUSH_INTERVAL) {
          target.accessHandle.flush();
          target.unflushedBytes = 0;
        }

        self.postMessage({
          type: 'WRITE_PROGRESS',
          fileId,
          fileName: target.sanitizedFileName,
          originalName: target.originalName,
          bytesWritten: target.bytesWritten,
          fileSize: target.fileSize,
        });
      } catch (err: any) {
        console.error('[OPFS Worker] Chunk write error:', err);
        self.postMessage({ type: 'ERROR', fileId, error: err.message });
      }
      break;
    }

    case 'CLOSE_FILE_STREAM':
    case 'FINALIZE_FILE': {
      const fileId = payload.fileId || currentFileId;
      if (!fileId) return;

      const target = activeFiles.get(fileId);
      if (!target) return;

      try {
        if (target.accessHandle) {
          target.accessHandle.flush();
          target.accessHandle.close();
          target.accessHandle = null; // Immediately release lock!
        }

        // Notify main thread that file is completely written and lock is released
        self.postMessage({
          type: 'TRANSFER_COMPLETE',
          fileId,
          fileName: target.sanitizedFileName,
          originalName: target.originalName,
          size: target.bytesWritten,
          mimeType: target.mimeType
        });
      } catch (err: any) {
        console.error('[OPFS Worker] Finalize file error:', err);
        self.postMessage({ type: 'ERROR', fileId, error: err.message });
      } finally {
        activeFiles.delete(fileId);
        if (currentFileId === fileId) {
          currentFileId = null;
        }
      }
      break;
    }

    case 'ABORT_FILE': {
      for (const [, target] of activeFiles.entries()) {
        try {
          if (target.accessHandle) {
            target.accessHandle.close();
            target.accessHandle = null;
          }
        } catch {}
      }
      activeFiles.clear();
      currentFileId = null;
      self.postMessage({ type: 'FILE_ABORTED' });
      break;
    }
  }
};
