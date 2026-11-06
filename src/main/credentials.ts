import { safeStorage } from "electron";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadKeys(dataDir: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, "provider-keys.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null);
    throw error;
  }
  await requireEncryption();
  const keys: Record<string, string> = Object.create(null);
  let rotate = false;
  for (const [provider, ciphertext] of Object.entries(JSON.parse(raw))) {
    if (typeof ciphertext !== "string") throw new Error("The provider key store is unreadable.");
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(ciphertext, "base64"));
    keys[provider] = result;
    rotate ||= shouldReEncrypt;
  }
  if (rotate) await storeKeys(dataDir, keys);
  return keys;
}

export async function storeKeys(dataDir: string, keys: Record<string, string>): Promise<void> {
  await requireEncryption();
  const entries = await Promise.all(Object.entries(keys).map(async ([provider, key]) => [
    provider, (await safeStorage.encryptStringAsync(key)).toString("base64"),
  ] as const));
  const file = join(dataDir, "provider-keys.json");
  const temporary = file + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function requireEncryption(): Promise<void> {
  if (!await safeStorage.isAsyncEncryptionAvailable()
    || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) {
    throw new Error("Unlock your operating system’s credential store to use saved provider keys.");
  }
}
