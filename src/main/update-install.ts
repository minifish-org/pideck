import type { HostCloseResult } from "../shared/transport";

type Installation = {
  seal(): void;
  unseal(): void;
  confirm(): Promise<boolean>;
  flush(): Promise<void>;
  closeHost(): Promise<HostCloseResult>;
  recover(): Promise<void>;
  install(): boolean;
  failed(error: unknown): void;
};

// Sparkle owns the download and installer. This only orders the app's shutdown
// before releasing its native installation handler.
export class UpdateInstallation {
  private pending?: Promise<void>;
  private installing = false;
  private invalidated = false;
  private hostClosed = false;

  constructor(private readonly actions: Installation) {}

  request(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.installing) return Promise.resolve();
    this.invalidated = false;
    this.actions.seal();
    const pending = this.prepare().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  private async restore() {
    this.installing = false;
    try {
      if (this.hostClosed) await this.actions.recover();
    } finally {
      this.hostClosed = false;
      this.actions.unseal();
    }
  }

  private async prepare() {
    try {
      if (!await this.actions.confirm() || this.invalidated) return;
      await this.actions.flush();
      if (this.invalidated) return;
      this.hostClosed = true;
      const closed = await this.actions.closeHost();
      if (closed.status !== "graceful") throw new Error("The workspace could not close safely. The update was not installed.");
      if (this.invalidated) return;
      this.installing = true;
      if (!this.actions.install()) throw new Error("The prepared update is no longer available.");
    } catch (error) {
      this.installing = false;
      this.actions.failed(error);
    } finally {
      if (!this.installing) {
        try { await this.restore(); }
        catch (error) { this.actions.failed(error); }
      }
    }
  }

  async aborted(): Promise<void> {
    this.invalidated = true;
    if (this.pending) return this.pending;
    if (this.installing || this.hostClosed) {
      try { await this.restore(); }
      catch (error) { this.actions.failed(error); }
    }
  }
}
