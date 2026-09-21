export type ControlMessage =
  | {
      type: 'FILE_START';
      fileId: string;
      fileName: string;
      fileSize: number;
      mimeType: string;
      chunkSize: number;
      totalChunks: number;
      expectedHash: string; // Hexadecimal SHA-256 string
    }
  | {
      type: 'FILE_END';
      fileId: string;
    }
  | {
      type: 'FILE_ACK';
      fileId: string;
      status: 'SUCCESS' | 'CORRUPTED' | 'ABORTED';
      error?: string;
    }
  | {
      type: 'BATCH_COMPLETE';
    }
  | {
      type: 'TRANSFER_ABORT';
      fileId?: string;
      reason?: string;
    };

export interface WorkerIncomingMessage {
  type: 'INIT_FILE' | 'WRITE_CHUNK' | 'FINALIZE_FILE' | 'ABORT_FILE';
  data?: any;
}

export interface WorkerOutgoingMessage {
  type: 'READY_FOR_DATA' | 'PROGRESS' | 'FILE_COMPLETE';
  fileId?: string;
  status?: 'SUCCESS' | 'CORRUPTED' | 'ABORTED';
  error?: string;
  bytes?: number;
  total?: number;
}
