export class CongestionController {
  private currentChunkSize = 128 * 1024; // 128 KB baseline
  private readonly minChunkSize = 32 * 1024;  // 32 KB floor
  private readonly maxChunkSize = 512 * 1024; // 512 KB ceiling
  private readonly highWatermark = 1.5 * 1024 * 1024; // 1.5 MB buffer trigger
  private readonly lowWatermark = 256 * 1024;        // 256 KB buffer drain

  public getChunkSize(): number {
    return this.currentChunkSize;
  }

  // Adjust chunk size based on total buffered bytes across channels
  public adapt(totalBufferedAmount: number): number {
    if (totalBufferedAmount > this.highWatermark) {
      // Backpressure detected: throttle chunk size to avoid packet drops
      this.currentChunkSize = Math.max(
        this.minChunkSize,
        Math.floor(this.currentChunkSize * 0.75)
      );
    } else if (totalBufferedAmount < this.lowWatermark) {
      // Pipe has spare capacity: scale up chunk size for lower CPU overhead
      this.currentChunkSize = Math.min(
        this.maxChunkSize,
        Math.floor(this.currentChunkSize * 1.25)
      );
    }
    return this.currentChunkSize;
  }
}