import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CredentialVault } from "../src/main/credentials";

test("credential migration and concurrent OAuth writes retain encrypted data across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-vault-"));
  // Reversible test encoding at the OS encryption boundary. Electron supplies
  // actual safeStorage in the app; the fixture checks migration and publication.
  const encode = (bytes: Buffer) => Buffer.from(bytes.map(byte => byte ^ 0xa5));
  let failWrites = true;
  const encryption = {
    async isAsyncEncryptionAvailable() { return true; },
    getSelectedStorageBackend() { return "gnome_libsecret" as const; },
    async encryptStringAsync(text: string) {
      if (failWrites) throw new Error("Fixture is locked");
      return encode(Buffer.from(text, "utf8"));
    },
    async decryptStringAsync(buffer: Buffer) {
      return { result: encode(buffer).toString("utf8"), shouldReEncrypt: false };
    },
  };
  try {
    const legacy = join(directory, "provider-keys.json");
    const legacyContents = JSON.stringify({ openai: encode(Buffer.from("legacy-test-key")).toString("base64") });
    await writeFile(legacy, legacyContents);
    const vault = new CredentialVault(directory, encryption);
    await assert.rejects(vault.snapshot(), /credential store/);
    assert.equal(await readFile(legacy, "utf8"), legacyContents);
    failWrites = false;
    assert.deepEqual((await vault.snapshot()).openai, { type: "api_key", key: "legacy-test-key" });
    await assert.rejects(readFile(legacy), { code: "ENOENT" });
    await Promise.all([
      vault.write("anthropic", { type: "api_key", key: "second-test-key" }),
      vault.write("github-copilot", { type: "oauth", access: "access-test-token", refresh: "refresh-test-token",
        expires: 1234, enterpriseUrl: "https://example.invalid" }),
    ]);
    const disk = await readFile(join(directory, "provider-credentials"), "utf8");
    assert.ok(!disk.includes("test-token") && !disk.includes("test-key"));
    const reopened = new CredentialVault(directory, encryption);
    assert.deepEqual(await reopened.snapshot(), Object.assign(Object.create(null), await vault.snapshot()));
    await reopened.write("github-copilot", null);
    assert.equal((await new CredentialVault(directory, encryption).snapshot())["github-copilot"], undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
