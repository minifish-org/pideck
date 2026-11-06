import type { SafeStorage } from "electron";
import type { Credential } from "@earendil-works/pi-ai";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Credentials = Record<string, Credential>;
type Encryption = Pick<SafeStorage, "isAsyncEncryptionAvailable" | "getSelectedStorageBackend"
  | "encryptStringAsync" | "decryptStringAsync">;
const unavailable = "Allow access to your system’s credential store and try again.";
const credentialFile = "provider-credentials";
const legacyFile = "provider-keys.json";

export class CredentialVault {
  private values?: Credentials;
  private opening?: Promise<Credentials>;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string, private readonly encryption: Encryption) {}

  async hasSavedCredentials(): Promise<boolean> {
    const files = await Promise.all([credentialFile, legacyFile].map(file =>
      access(join(this.dataDir, file)).then(() => true, error => error.code !== "ENOENT")));
    return files.some(Boolean);
  }

  async snapshot(): Promise<Credentials> {
    await this.writes;
    return this.load();
  }

  write(provider: string, credential: Credential | null): Promise<void> {
    const write = this.writes.then(async () => {
      const current = await this.load();
      const next = { ...current };
      if (credential) next[provider] = credential;
      else delete next[provider];
      if (Object.keys(next).length) await this.save(next);
      else {
        try {
          await rm(join(this.dataDir, legacyFile), { force: true });
          await rm(join(this.dataDir, credentialFile), { force: true });
        } catch {
          throw new Error("The provider credential store could not be removed.");
        }
      }
      this.values = next;
    });
    this.writes = write.catch(() => {});
    return write;
  }

  private load(): Promise<Credentials> {
    if (this.values) return Promise.resolve(this.values);
    this.opening ??= this.read().then(values => this.values = values).finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async read(): Promise<Credentials> {
    const file = join(this.dataDir, credentialFile);
    const encrypted = await readOptional(file);
    if (encrypted) {
      await this.requireEncryption();
      const { result, shouldReEncrypt } = await this.decrypt(encrypted);
      const values = parseRecords(result, isCredential);
      if (shouldReEncrypt) await this.save(values);
      return values;
    }
    // Migrate v0.1's encrypted API keys into pi-ai's native credential format.
    const oldFile = join(this.dataDir, legacyFile);
    const old = await readOptional(oldFile);
    const values: Credentials = Object.create(null);
    if (old) {
      await this.requireEncryption();
      const keys = parseRecords(old.toString("utf8"), (value): value is string => typeof value === "string");
      for (const [provider, ciphertext] of Object.entries(keys)) {
        values[provider] = { type: "api_key", key: (await this.decrypt(Buffer.from(ciphertext, "base64"))).result };
      }
      if (Object.keys(values).length) await this.save(values);
      await rm(oldFile, { force: true });
    }
    return values;
  }

  private async save(values: Credentials): Promise<void> {
    await this.requireEncryption();
    const encrypted = await this.encryption.encryptStringAsync(JSON.stringify(values)).catch(() => {
      throw new Error(unavailable);
    });
    const file = join(this.dataDir, credentialFile);
    const temporary = file + ".tmp";
    try {
      await writeFile(temporary, encrypted, { mode: 0o600 });
      await rename(temporary, file);
    } catch {
      throw new Error("The provider credential store could not be written.");
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async decrypt(encrypted: Buffer) {
    try {
      return await this.encryption.decryptStringAsync(encrypted);
    } catch {
      throw new Error(unavailable);
    }
  }

  private async requireEncryption() {
    if (!await this.encryption.isAsyncEncryptionAvailable()
      || (process.platform === "linux" && this.encryption.getSelectedStorageBackend() === "basic_text")) {
      throw new Error(unavailable);
    }
  }
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Record<string, unknown>;
  return credential.type === "api_key"
    ? (credential.key === undefined || typeof credential.key === "string")
    : credential.type === "oauth" && typeof credential.access === "string"
      && typeof credential.refresh === "string" && Number.isFinite(credential.expires);
}

function parseRecords<T>(data: string, valid: (value: unknown) => value is T): Record<string, T> {
  try {
    const raw: unknown = JSON.parse(data);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
    const values: Record<string, T> = Object.create(null);
    for (const [provider, value] of Object.entries(raw)) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider) || !valid(value)) throw new Error();
      values[provider] = value;
    }
    return values;
  } catch {
    throw new Error("The provider credential store is unreadable.");
  }
}

async function readOptional(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("The provider credential store could not be read.");
  }
}
