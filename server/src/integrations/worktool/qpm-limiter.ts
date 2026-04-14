export class QpmLimiter {
  private readonly maxQpm: number;
  private timestamps: number[] = [];

  constructor(maxQpm: number) {
    this.maxQpm = maxQpm;
  }

  async waitForSlot(): Promise<void> {
    while (true) {
      const now = Date.now();
      const oneMinuteAgo = now - 60_000;
      this.timestamps = this.timestamps.filter((ts) => ts > oneMinuteAgo);
      if (this.timestamps.length < this.maxQpm) {
        this.timestamps.push(now);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
}
