// A renderer is disposable; the trusted host and its live tasks are not.
export class RendererRecovery {
  private lastAttempt = -Infinity;
  private used = false;
  constructor(private readonly interval = 60_000) {}

  automatic(now = Date.now()): boolean {
    if (now - this.lastAttempt >= this.interval) this.used = false;
    if (this.used) return false;
    this.used = true;
    this.lastAttempt = now;
    return true;
  }

  retry(): void { this.used = false; }
}
