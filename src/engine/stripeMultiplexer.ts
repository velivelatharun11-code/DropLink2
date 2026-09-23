const DEFAULT_HIGH_WATER_MARK = 1024 * 1024; // 1 MB
const DEFAULT_LOW_WATER_MARK = 256 * 1024;   // 256 KB

export class StripeMultiplexer {
  private channels: RTCDataChannel[];
  private highWaterMark: number;
  private lowWaterMark: number;
  private channelCursor: number = 0;

  constructor(
    channels: RTCDataChannel[],
    highWaterMark = DEFAULT_HIGH_WATER_MARK,
    lowWaterMark = DEFAULT_LOW_WATER_MARK
  ) {
    this.channels = channels;
    this.highWaterMark = highWaterMark;
    this.lowWaterMark = lowWaterMark;

    for (const ch of this.channels) {
      if ('bufferedAmountLowThreshold' in ch) {
        ch.bufferedAmountLowThreshold = this.lowWaterMark;
      }
    }
  }

  public getActiveChannels(): RTCDataChannel[] {
    return this.channels.filter((c) => c.readyState === 'open');
  }

  public async waitForDrain(channel: RTCDataChannel): Promise<void> {
    if (channel.bufferedAmount <= this.lowWaterMark) return;

    return new Promise((resolve) => {
      let resolved = false;
      let timer: any = null;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        if (timer) clearInterval(timer);
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onLow);
        resolve();
      };

      const onLow = () => cleanup();

      channel.addEventListener('bufferedamountlow', onLow);
      channel.addEventListener('close', onLow);

      // Polling fallback to guarantee zero deadlock even if browser misses event
      timer = setInterval(() => {
        if (channel.bufferedAmount <= this.lowWaterMark || channel.readyState !== 'open') {
          cleanup();
        }
      }, 25);

      // Immediate check in case it dropped right as listener was attached
      if (channel.bufferedAmount <= this.lowWaterMark || channel.readyState !== 'open') {
        cleanup();
      }
    });
  }

  public async sendPacket(packet: Uint8Array): Promise<void> {
    const active = this.getActiveChannels();
    if (active.length === 0) {
      throw new Error('NoActiveDataChannels: All transfer stripes are closed or dropped');
    }

    const channel = active[this.channelCursor % active.length];
    this.channelCursor++;

    if (channel.bufferedAmount >= this.highWaterMark) {
      await this.waitForDrain(channel);
    }

    if (channel.readyState === 'open') {
      channel.send(packet.buffer as ArrayBuffer);
    } else {
      const healthy = this.getActiveChannels();
      if (healthy.length === 0) {
        throw new Error('AllStripesClosedDuringDrain');
      }
      healthy[0].send(packet.buffer as ArrayBuffer);
    }
  }

  public async flush(): Promise<void> {
    while (this.getActiveChannels().some((c) => c.bufferedAmount > 0)) {
      await new Promise((res) => setTimeout(res, 10));
    }
  }
}
