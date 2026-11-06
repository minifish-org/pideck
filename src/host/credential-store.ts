import type { AuthOperationOptions, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { AsyncLocalStorage } from "node:async_hooks";

// pi-ai resolves and refreshes credentials under modify's per-provider lock.
// Commit to the OS-encrypted vault before publishing the new value to requests.
export class PersistentCredentials implements CredentialStore {
  private readonly values: Map<string, Credential>;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly passiveReads = new AsyncLocalStorage<true>();
  private unlocking?: Promise<void>;
  private afterUnlock?: () => Promise<unknown>;

  constructor(
    initial: Record<string, Credential>,
    private readonly persist: (provider: string, value: Credential | null) => Promise<void>,
    private readSaved?: () => Promise<Record<string, Credential>>,
  ) {
    this.values = new Map(Object.entries(initial));
  }

  async read(provider: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    if (!this.passiveReads.getStore()) await this.unlock();
    options?.signal?.throwIfAborted();
    return this.values.get(provider);
  }

  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    if (!this.passiveReads.getStore()) await this.unlock();
    options?.signal?.throwIfAborted();
    return [...this.values].map(([providerId, value]) => ({ providerId, type: value.type }));
  }

  get savedConnectionsPending() {
    return Boolean(this.readSaved);
  }

  passive<T>(operation: () => Promise<T>): Promise<T> {
    // pi-ai checks credentials when restoring catalogs and listing usable models.
    // Keep those reads passive without blocking a concurrent real model request.
    return this.passiveReads.run(true, operation);
  }

  onUnlock(operation: () => Promise<unknown>) {
    this.afterUnlock = operation;
  }

  async unlock(): Promise<void> {
    if (!this.readSaved) return;
    this.unlocking ??= this.readSaved().then(async values => {
      for (const [provider, credential] of Object.entries(values)) this.values.set(provider, credential);
      if (this.afterUnlock) await this.passive(this.afterUnlock);
      this.readSaved = undefined;
    }).finally(() => { this.unlocking = undefined; });
    await this.unlocking;
  }

  modify(
    provider: string,
    change: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    return this.serial(provider, options, async () => {
      const current = this.values.get(provider);
      const next = await change(current);
      options?.signal?.throwIfAborted();
      if (!next) return current;
      await this.persist(provider, next);
      this.values.set(provider, next);
      return next;
    });
  }

  delete(provider: string, options?: AuthOperationOptions) {
    return this.serial(provider, options, async () => {
      if (!this.values.has(provider)) return;
      await this.persist(provider, null);
      this.values.delete(provider);
    });
  }

  private serial<T>(provider: string, options: AuthOperationOptions | undefined, operation: () => Promise<T>) {
    const previous = this.pending.get(provider) ?? Promise.resolve();
    const result = previous.then(async () => {
      options?.signal?.throwIfAborted();
      await this.unlock();
      options?.signal?.throwIfAborted();
      return operation();
    });
    const tail = result.then(() => {}, () => {});
    this.pending.set(provider, tail);
    void tail.then(() => {
      if (this.pending.get(provider) === tail) this.pending.delete(provider);
    });
    return result;
  }
}
