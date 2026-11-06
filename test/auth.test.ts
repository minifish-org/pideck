import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AuthFlows } from "../src/host/auth-flows";
import { PersistentCredentials } from "../src/host/credential-store";
import { shellEnvironment } from "../src/host/shell-env";
import { hostEnvironment } from "../src/main/host-env";
import { validPayload } from "../src/main/validation";
import type { HostEvent } from "../src/shared/api";

test("OAuth uses native prompts, scoped browser intents, and serialized durable refresh", async () => {
  const persisted = new Map<string, Credential>();
  const writes: Credential[] = [];
  const credentials = new PersistentCredentials({}, async (provider, credential) => {
    if (credential) {
      writes.push(credential);
      persisted.set(provider, credential);
    } else persisted.delete(provider);
  });
  const models = createModels({ credentials });
  const base = fauxProvider().provider;
  const deviceId = randomUUID();
  let refreshes = 0;
  models.setProvider({
    ...base,
    auth: {
      oauth: {
        name: "Test account",
        async login(interaction, options) {
          assert.equal(options?.getDeviceId?.(), deviceId);
          interaction.notify({ type: "auth_url", url: "file:///private/auth" });
          interaction.notify({ type: "auth_url", url: "https://account.example.invalid/authorize?state=nonce" });
          const value = await interaction.prompt({
            type: "select", message: "Choose a region", options: [{ id: "test", label: "Test" }],
          });
          assert.equal(value, "test");
          interaction.notify({ type: "device_code", userCode: "TEST-CODE", verificationUri: "https://account.example.invalid/device" });
          const code = await interaction.prompt({ type: "manual_code", message: "Enter code" });
          assert.equal(code, "callback-code");
          return { type: "oauth", access: "old-access", refresh: "refresh-token", expires: 0 };
        },
        async refresh(previous) {
          refreshes++;
          assert.equal(previous.refresh, "refresh-token");
          return { ...previous, access: "new-access", expires: Date.now() + 3_600_000 };
        },
        async toAuth(credential) { return { apiKey: credential.access }; },
      },
    },
  });

  const events: HostEvent[] = [];
  const nextPrompt: { current?: (event: Extract<HostEvent, { type: "auth:prompt" }>) => void } = {};
  const flows = new AuthFlows(models, credentials, (owner, event) => {
    assert.equal(owner, 7);
    events.push(event);
    if (event.type === "auth:prompt") nextPrompt.current?.(event);
  }, () => deviceId);
  const waitPrompt = () => new Promise<Extract<HostEvent, { type: "auth:prompt" }>>(resolve => {
    nextPrompt.current = resolve;
  });
  const id = randomUUID();
  const first = waitPrompt();
  const signingIn = flows.login(7, id, base.id, "oauth");
  const region = await first;
  assert.equal(region.prompt.type, "select");
  assert.throws(() => flows.answer(6, id, region.promptId, "test"), /no longer active/);
  assert.throws(() => flows.answer(7, id, region.promptId, "invalid"), /available provider options/);
  const browserLinks = events.flatMap(event =>
    event.type === "auth:notice" && event.notice.type === "auth_url" ? [event.notice.link] : []);
  assert.equal(browserLinks.length, 1);
  assert.equal(browserLinks[0].domain, "account.example.invalid");
  assert.equal(flows.link(7, id, browserLinks[0].id), "https://account.example.invalid/authorize?state=nonce");
  assert.throws(() => flows.link(7, id, randomUUID()), /no longer active/);
  const second = waitPrompt();
  flows.answer(7, id, region.promptId, "test");
  const code = await second;
  const device = events.flatMap(event =>
    event.type === "auth:notice" && event.notice.type === "device_code" ? [event.notice] : [])[0];
  assert.equal(flows.code(7, id, device.copyId!), "TEST-CODE");
  flows.answer(7, id, code.promptId, "callback-code");
  await signingIn;
  assert.throws(() => flows.link(7, id, browserLinks[0].id), /no longer active/);

  const provider = (await flows.providers()).find(item => item.id === base.id);
  assert.equal(provider?.credential, "oauth");
  assert.equal(provider.configured, true);
  assert.ok(!JSON.stringify(provider).includes("refresh-token"));
  const results = await Promise.all([models.getAuth(base.id), models.getAuth(base.id)]);
  assert.deepEqual(results.map(result => result?.auth.apiKey), ["new-access", "new-access"]);
  assert.equal(refreshes, 1);
  assert.equal(writes.length, 2);
  assert.equal(persisted.get(base.id)?.type, "oauth");
  await flows.logout(base.id);
  assert.equal(await credentials.read(base.id), undefined);
  assert.equal(persisted.size, 0);
});

test("closing the owning window aborts pending native login without persisting anything", async () => {
  const credentials = new PersistentCredentials({}, async () => assert.fail("Unexpected persisted credential"));
  const models = createModels({ credentials });
  const base = fauxProvider().provider;
  models.setProvider({ ...base, auth: { apiKey: {
    name: "API key",
    resolve: async () => undefined,
    async login(interaction) {
      return { type: "api_key", key: await interaction.prompt({ type: "secret", message: "Enter key" }) };
    },
  } } });
  const opened = Promise.withResolvers<void>();
  const flows = new AuthFlows(models, credentials, (owner, event) => {
    if (owner === 5 && event.type === "auth:prompt") opened.resolve();
  });
  const login = flows.login(5, randomUUID(), base.id, "api_key");
  const rejected = assert.rejects(login, /cancelled/);
  await opened.promise;
  flows.closeOwner(5);
  await rejected;
  assert.deepEqual(await credentials.list(), []);
});

test("native provider environment stays in the host and auth IPC only accepts scoped IDs", () => {
  const env = hostEnvironment({
    OPENAI_API_KEY: "provider-key",
    AZURE_OPENAI_BASE_URL: "http://127.0.0.1:1234/openai/v1",
    AWS_PROFILE: "workspace",
    NODE_OPTIONS: "--require injected.js",
  });
  assert.equal(env.OPENAI_API_KEY, "provider-key");
  assert.equal(env.AWS_PROFILE, "workspace");
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(shellEnvironment(env).OPENAI_API_KEY, undefined);
  assert.equal(shellEnvironment(env).AWS_PROFILE, undefined);
  assert.equal(validPayload("model:auth-open", { flowId: randomUUID(), linkId: "https://example.invalid" }), false);
  assert.equal(validPayload("model:login", { flowId: randomUUID(), method: "invalid", provider: "openai" }), false);
});
