const MAX_BUFFERED_AMOUNT = 64 * 1024; // 64 KB threshold to avoid SCTP packet loss

/**
 * Sends a single chunk through an RTCDataChannel while respecting
 * the internal SCTP buffer threshold to prevent packet drops.
 */
export async function sendChunkWithBackpressure(
  channel: RTCDataChannel,
  chunk: ArrayBuffer
): Promise<void> {
  if (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    await new Promise<void>((resolve) => {
      channel.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT / 2;

      const onBufferedAmountLow = () => {
        channel.removeEventListener('bufferedamountlow', onBufferedAmountLow);
        resolve();
      };

      channel.addEventListener('bufferedamountlow', onBufferedAmountLow);
    });
  }

  channel.send(chunk);
}
