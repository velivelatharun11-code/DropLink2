import type { WorkerOutgoingMessage } from '../types/protocol';

interface ActiveFileSession {
  fileId: string;
  fileName: string;
  fileSize: number;
  expectedHash: string;
  receivedBytes: number;
  handle: FileSystemFileHandle;
  writable: FileSystemWritableFileStream;
}

let currentSession: ActiveFileSession | null = null;

self.onmessage = async (event: MessageEvent) => {
  const { type, data } = event.data;

  switch (type) {
    case 'INIT_FILE': {
      try {
        const meta = data;
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(meta.fileName, { create: true });
        const writable = await handle.createWritable({ keepExistingData: false });

        currentSession = {
          fileId: meta.fileId,
          fileName: meta.fileName,
          fileSize: meta.fileSize,
          expectedHash: meta.expectedHash,
          receivedBytes: 0,
          handle,
          writable
        };

        const response: WorkerOutgoingMessage = {
          type: 'READY_FOR_DATA',
          fileId: meta.fileId
        };
        self.postMessage(response);
      } catch (err: any) {
        const response: WorkerOutgoingMessage = {
          type: 'FILE_COMPLETE',
          fileId: data?.fileId,
          status: 'CORRUPTED',
          error: `Failed to initialize OPFS file: ${err.message}`
        };
        self.postMessage(response);
      }
      break;
    }

    case 'WRITE_CHUNK': {
      if (!currentSession) return;
      const chunk: ArrayBuffer = data.chunk;

      try {
        await currentSession.writable.write(chunk);
        currentSession.receivedBytes += chunk.byteLength;

        const progressMsg: WorkerOutgoingMessage = {
          type: 'PROGRESS',
          fileId: currentSession.fileId,
          bytes: currentSession.receivedBytes,
          total: currentSession.fileSize
        };
        self.postMessage(progressMsg);
      } catch (err: any) {
        const errorMsg: WorkerOutgoingMessage = {
          type: 'FILE_COMPLETE',
          fileId: currentSession.fileId,
          status: 'CORRUPTED',
          error: `Disk write failed: ${err.message}`
        };
        self.postMessage(errorMsg);
      }
      break;
    }

    case 'FINALIZE_FILE': {
      if (!currentSession) return;

      try {
        await currentSession.writable.close();

        const diskFile = await currentSession.handle.getFile();
        const diskBuffer = await diskFile.arrayBuffer();
        const hashBytes = await crypto.subtle.digest('SHA-256', diskBuffer);
        const computedHash = Array.from(new Uint8Array(hashBytes))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');

        const isMatch =
          computedHash.toLowerCase() === currentSession.expectedHash.toLowerCase();

        if (isMatch) {
          const successMsg: WorkerOutgoingMessage = {
            type: 'FILE_COMPLETE',
            fileId: currentSession.fileId,
            status: 'SUCCESS'
          };
          self.postMessage(successMsg);
        } else {
          const mismatchMsg: WorkerOutgoingMessage = {
            type: 'FILE_COMPLETE',
            fileId: currentSession.fileId,
            status: 'CORRUPTED',
            error: `Hash mismatch. Expected: ${currentSession.expectedHash}, Got: ${computedHash}`
          };
          self.postMessage(mismatchMsg);
        }
      } catch (err: any) {
        const failMsg: WorkerOutgoingMessage = {
          type: 'FILE_COMPLETE',
          fileId: currentSession.fileId,
          status: 'CORRUPTED',
          error: `Finalization error: ${err.message}`
        };
        self.postMessage(failMsg);
      } finally {
        currentSession = null;
      }
      break;
    }

    case 'ABORT_FILE': {
      if (currentSession) {
        const fileId = currentSession.fileId;
        const fileName = currentSession.fileName;
        try {
          if (currentSession.writable) {
            await currentSession.writable.abort().catch(() => {});
          }
          const root = await navigator.storage.getDirectory();
          await root.removeEntry(fileName).catch(() => {});
        } catch (err: any) {
          console.warn('Worker OPFS abort cleanup error:', err);
        } finally {
          currentSession = null;
          const abortMsg: WorkerOutgoingMessage = {
            type: 'FILE_COMPLETE',
            fileId,
            status: 'ABORTED',
            error: data?.reason || 'Transfer aborted'
          };
          self.postMessage(abortMsg);
        }
      }
      break;
    }
  }
};
