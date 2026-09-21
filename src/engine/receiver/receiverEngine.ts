import type { ControlMessage, WorkerOutgoingMessage } from '../../types/protocol';

export class ReceiverEngine {
  private controlChannel: RTCDataChannel;
  private dataChannel: RTCDataChannel;
  private worker: Worker;

  constructor(controlChannel: RTCDataChannel, dataChannel: RTCDataChannel) {
    this.controlChannel = controlChannel;
    this.dataChannel = dataChannel;

    this.worker = new Worker(
      new URL('../../workers/receiver.worker.ts', import.meta.url),
      { type: 'module' }
    );

    this.initChannels();
    this.initWorkerListener();
  }

  private initWorkerListener() {
    this.worker.onmessage = (e: MessageEvent<WorkerOutgoingMessage>) => {
      const { type, fileId, status, error, bytes, total } = e.data;

      if (type === 'FILE_COMPLETE' && fileId && status) {
        const ack: ControlMessage = {
          type: 'FILE_ACK',
          fileId,
          status,
          error
        };
        this.controlChannel.send(JSON.stringify(ack));
      }

      if (type === 'PROGRESS') {
        window.dispatchEvent(
          new CustomEvent('droplink:progress', { detail: { fileId, bytes, total } })
        );
      }
    };
  }

  private initChannels() {
    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.worker.postMessage(
          { type: 'WRITE_CHUNK', data: { chunk: event.data } },
          [event.data]
        );
      }
    };

    this.controlChannel.onmessage = (event: MessageEvent) => {
      try {
        const message: ControlMessage = JSON.parse(event.data);

        if (message.type === 'FILE_START') {
          this.worker.postMessage({ type: 'INIT_FILE', data: message });
        } else if (message.type === 'FILE_END') {
          this.worker.postMessage({
            type: 'FINALIZE_FILE',
            data: { fileId: message.fileId }
          });
        } else if (message.type === 'BATCH_COMPLETE') {
          window.dispatchEvent(new CustomEvent('droplink:batch_complete'));
        }
      } catch (err) {
        console.error('Failed to parse control message:', err);
      }
    };
  }

  public destroy() {
    this.worker.terminate();
  }
}
