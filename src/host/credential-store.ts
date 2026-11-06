import type { AuthOperationOptions, Credential, CredentialStore } from "@earendil-works/pi-ai";

// pi-ai resolves and refreshes credentials under modify's per-provider lock.
// Commit to the OS-encrypted vault before publishing the new value to requests.
export class PersistentCredentials implements CredentialStore {
  private readonly values: Map<string, Credential>;
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    initial: Record<string, Credential>,
    private readonly persist: (provider: string, value: Credential | null) => Promise<void>,
    private readonly locked = false,
  ) {
    this.values = new Map(Object.entries(initial));
  }

  async read(provider: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    this.requireUnlocked();
    return this.values.get(provider);
  }

  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return [...this.values].map(([providerId, value]) => ({ providerId, type: value.type }));
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
    const result = previous.then(() => {
      options?.signal?.throwIfAborted();
      this.requireUnlocked();
      return operation();
    });
    const tail = result.then(() => {}, () => {});
    this.pending.set(provider, tail);
    void tail.then(() => {
      if (this.pending.get(provider) === tail) this.pending.delete(provider);
    });
    return result;
  }

  private requireUnlocked() {
    if (this.locked) throw new Error("Unlock your system credential store and reopen Pideck.");
  }
}
