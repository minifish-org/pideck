import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { CredentialVault } from '../src/main/credentials';
import type { HostClient as Client } from '../src/main/host-client';
import type { ToHost } from '../src/shared/transport';
import { validPayload } from '../src/main/validation';

// Exercise the production client without loading Electron in Node. Only the
// utility-process boundary is replaced; lifecycle/retry code remains intact.
const source = new URL('../src/main/host-client.ts', import.meta.url);
const compiled = build({ entryPoints: [fileURLToPath(source)], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['electron'],
  define: { 'import.meta.url': JSON.stringify(source.href) } });

class Process extends EventEmitter {
  readonly messages: ToHost[] = [];
  kills = 0;
  postMessage(message: ToHost) {
    this.messages.push(message);
    if (message.type === 'request') {
      this.emit('message', { type: 'result', id: message.id, value: [] });
    }
  }
  kill() { this.kills++; this.emit('exit', 1); return true; }
  ready() { this.emit('message', { type: 'ready' }); }
}

async function fixture() {
  const processes: Process[] = [];
  const electron = { utilityProcess: { fork() {
    const child = new Process(); processes.push(child); return child;
  } } };
  const nativeRequire = createRequire(import.meta.url);
  const module = { exports: {} as { HostClient: typeof Client } };
  const code = (await compiled).outputFiles[0]!.text;
  new Function('require', 'module', 'exports', code)(
    (name: string) => name === 'electron' ? electron : nativeRequire(name), module, module.exports);
  let restarts = 0;
  const vault = { hasSavedCredentials: async () => false } as CredentialVault;
  const client = new module.exports.HostClient('/unused-profile', vault, () => {}, () => { restarts++; }, () => {});
  return { client, processes, restarts: () => restarts };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('explicit recovery is a narrow main-process command', () => {
  assert.equal(validPayload('host:recover', undefined), true);
  for (const value of [null, {}, { force: true }, { command: 'chat:send' }]) {
    assert.equal(validPayload('host:recover', value), false);
  }
});

test('recovery waits for startup and leaves a healthy host and its input untouched', async () => {
  const { client, processes, restarts } = await fixture();
  client.start();
  const first = client.recover();
  const second = client.recover();
  assert.equal(processes.length, 1);
  processes[0]!.ready();
  await Promise.all([first, second]);
  await settle();
  const messages = processes[0]!.messages.length;
  await client.recover();
  assert.equal(processes.length, 1);
  assert.equal(processes[0]!.messages.length, messages);
  assert.equal(processes[0]!.kills, 0);
  assert.equal(restarts(), 0);
});

test('manual recovery restarts a fatal host once and broadcasts reattachment without replaying requests', async () => {
  const { client, processes, restarts } = await fixture();
  client.start();
  processes[0]!.emit('message', { type: 'fatal', error: 'Temporary store failure' });
  await assert.rejects(client.request(1, 'project:list', undefined), /Temporary store failure/);
  const first = client.recover();
  const second = client.recover();
  assert.equal(processes.length, 2);
  processes[1]!.ready();
  await Promise.all([first, second]);
  await settle();
  assert.equal(restarts(), 1);
  assert.deepEqual(processes[1]!.messages.map(message => message.type), ['start']);
  assert.deepEqual(await client.request(2, 'project:list', undefined), []);
});

test('recovery resets an exhausted retry budget and preserves the full automatic retry allowance', async t => {
  const { client, processes, restarts } = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  client.start();
  for (let index = 0; index < 6; index++) {
    processes[index]!.ready();
    processes[index]!.kill();
    if (index < 5) {
      t.mock.timers.tick(Math.min(4_000, 250 * 2 ** index));
      await settle();
    }
  }
  assert.equal(processes.length, 6);
  await assert.rejects(client.request(1, 'project:list', undefined), /unavailable/);
  const recovered = client.recover();
  assert.equal(processes.length, 7);
  processes[6]!.ready();
  await recovered;
  for (let index = 0; index < 5; index++) {
    processes[6 + index]!.kill();
    t.mock.timers.tick(Math.min(4_000, 250 * 2 ** index));
    await settle();
    processes[7 + index]!.ready();
  }
  assert.equal(processes.length, 12);
  assert.equal(restarts(), 11);
  assert.ok(processes.every(child => child.messages.every(message => message.type === 'start')));
});

test('manual recovery shares an automatic restart and is rejected during shutdown', async t => {
  const { client, processes } = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  client.start(); processes[0]!.ready(); processes[0]!.kill();
  const recovered = client.recover();
  assert.equal(processes.length, 1);
  t.mock.timers.tick(250); await settle();
  assert.equal(processes.length, 2);
  processes[1]!.ready(); await recovered;
  const closed = client.close();
  await assert.rejects(client.recover(), /closing/);
  processes[1]!.emit('message', { type: 'shutdown:complete' });
  processes[1]!.emit('exit', 0);
  assert.deepEqual(await closed, { status: 'graceful' });
  assert.equal(processes.length, 2);
});
