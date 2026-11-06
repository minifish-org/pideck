import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PersistentCredentials } from "../src/host/credential-store";
import { Runtime } from "../src/host/runtime";
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
    await reopened.write("anthropic", null);
    await writeFile(legacy, legacyContents); // A stale pre-migration file must not resurrect a disconnected key.
    await reopened.write("openai", null);
    assert.equal(await new CredentialVault(directory, encryption).hasSavedCredentials(), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("opening a saved profile and reading its model catalog never access the OS credential store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-lazy-vault-"));
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalAzure = process.env.AZURE_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.AZURE_OPENAI_API_KEY = "ambient-fixture-key";
  let allowed = false;
  let probes = 0;
  let decrypts = 0;
  const vault = new CredentialVault(directory, {
    async isAsyncEncryptionAvailable() { probes++; return allowed; },
    getSelectedStorageBackend() { return "gnome_libsecret"; },
    async encryptStringAsync() { assert.fail("Reading credentials must not write to the OS store."); },
    async decryptStringAsync(buffer) {
      decrypts++;
      assert.equal(buffer.toString(), "sealed-fixture");
      return { result: '{"openai":{"type":"api_key","key":"saved-fixture-key"}}', shouldReEncrypt: false };
    },
  });
  let runtime: Runtime | undefined;
  try {
    assert.equal(await vault.hasSavedCredentials(), false);
    await writeFile(join(directory, "provider-credentials"), "sealed-fixture");
    assert.equal(await vault.hasSavedCredentials(), true);
    const credentials = new PersistentCredentials({}, (provider, value) => vault.write(provider, value),
      () => vault.snapshot());
    runtime = await Runtime.open(directory, {}, undefined, credentials);
    const passive = await runtime.modelCatalog();
    assert.equal(passive.savedConnectionsPending, true);
    assert.ok(passive.models.some(model => model.provider === "azure" && model.configured));
    assert.ok(!passive.models.some(model => model.provider === "openai" && model.configured));
    assert.deepEqual([probes, decrypts], [0, 0]);

    const unlock = () => runtime!.modelCatalog(true);
    await Promise.all([assert.rejects(unlock(), /credential store/), assert.rejects(unlock(), /credential store/)]);
    assert.deepEqual([probes, decrypts], [1, 0]);
    assert.equal((await runtime.modelCatalog()).savedConnectionsPending, true);
    assert.deepEqual([probes, decrypts], [1, 0]);

    allowed = true;
    const catalog = await unlock();
    assert.equal(catalog.savedConnectionsPending, false);
    assert.ok(catalog.models.some(model => model.provider === "openai" && model.configured));
    assert.ok(!JSON.stringify(catalog).includes("fixture-key"));
    assert.equal((await runtime.modelCatalog()).savedConnectionsPending, false);
    assert.deepEqual([probes, decrypts], [2, 1]);
  } finally {
    if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalAzure === undefined) delete process.env.AZURE_OPENAI_API_KEY;
    else process.env.AZURE_OPENAI_API_KEY = originalAzure;
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
