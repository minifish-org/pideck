import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Automation } from '../src/host/automation';

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(workspace = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pideck automation's-test-")));
  const resourcesDirectory = join(root, 'resources');
  const stateDirectory = join(root, 'state');
  const projectDirectory = join(root, 'project');
  await Promise.all([mkdir(resourcesDirectory), mkdir(projectDirectory)]);
  if (workspace) await mkdir(join(projectDirectory, '.playwright'));
  const node = join(resourcesDirectory, 'node');
  await writeFile(node, `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
  const chromium = join(resourcesDirectory, 'chromium');
  await writeFile(chromium, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const log = join(root, 'calls.jsonl');
  const cli = join(resourcesDirectory, 'upstream.cjs');
  await writeFile(cli, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const defaults=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.playwright','cli.config.json')));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,cwd:process.cwd(),home:process.env.HOME,runtime:process.env.XDG_RUNTIME_DIR,username:process.env.USERNAME,nodePath:process.env.PATH,executable:defaults.browser.launchOptions.executablePath,noUpdate:process.env.NO_UPDATE_NOTIFIER})+'\\n');
const state = path.join(process.env.HOME, 'browser.json');
const workspace = fs.existsSync(path.join(process.cwd(), '.playwright')) ? process.cwd() : '0123456789abcdef';
if (args[0] === 'open') fs.writeFileSync(state, JSON.stringify({workspace}));
if (args[0] === 'close-all') { try { if (JSON.parse(fs.readFileSync(state)).workspace === workspace) fs.unlinkSync(state); } catch {} }
if (args[0] === 'list') console.log(JSON.stringify({browsers:fs.existsSync(state)?[JSON.parse(fs.readFileSync(state))]:[]}));
else console.log(JSON.stringify({args,home:process.env.HOME}));
`);
  await writeFile(join(resourcesDirectory, 'manifest.json'), JSON.stringify({ schema: 1, platform: process.platform, arch: process.arch,
    nodeVersion: '22.23.4', cliVersion: '0.1.23', playwrightVersion: '1.65.0-alpha-2026-10-30', browserRevision: '1252',
    node: 'node', cli: 'upstream.cjs', chromium: 'chromium' }));
  const launcherPath = join(root, 'cli.cjs');
  await build({ entryPoints: ['src/automation/cli.ts'], outfile: launcherPath, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
  const options = { resourcesDirectory, stateDirectory, launcherPath };
  let automation = await Automation.open(options);
  const call = async (environment: Record<string, string>, args: string[]) => {
    const shim = join(environment.PATH.split(delimiter)[0], 'playwright-cli');
    return execute(shim, args, { cwd: projectDirectory, env: { ...process.env, ...environment } });
  };
  return { root, options, resourcesDirectory, stateDirectory, projectDirectory, call, get automation() { return automation; },
    async reopen(resources = resourcesDirectory) { automation = await Automation.open({ ...options, resourcesDirectory: resources }); },
    async calls() { return (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); },
    async close() { await automation.closeAll(); await rm(root, { recursive: true, force: true }); },
  };
}

test('browser CLI preserves argv and cwd while isolating its profile and socket namespace per conversation', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.automation.availability(), { available: true });
    const [a, duplicate, b] = await Promise.all([
      f.automation.environment('project-a', '1', f.projectDirectory),
      f.automation.environment('project-a', '1', f.projectDirectory),
      f.automation.environment('project-a', '2', f.projectDirectory),
    ]);
    assert.deepEqual(a, duplicate);
    assert.deepEqual(Object.keys(a), ['PATH'], 'Project Node/npm keep the real HOME and do not inherit CLI-only overrides.');
    const argv = ['open', 'data:text/html,a b', '-s=shared', '--config', 'config with spaces.json'];
    await f.call(a, argv); await f.call(b, argv);
    const calls = await f.calls();
    assert.deepEqual(calls[0].args, argv);
    assert.equal(calls[0].cwd, f.projectDirectory);
    assert.notEqual(calls[0].home, process.env.HOME);
    assert.notEqual(calls[0].home, calls[1].home);
    assert.notEqual(calls[0].runtime, calls[1].runtime);
    assert.notEqual(calls[0].username, calls[1].username);
    assert.ok(Buffer.byteLength(join(calls[0].runtime, 'playwright', 'cli', '1234567890123456.sock')) < 104);
    assert.equal(calls[0].noUpdate, '1');
    assert.equal(calls[0].executable, join(f.resourcesDirectory, 'chromium'));
    await assert.rejects(f.automation.environment('other-project', '1', f.projectDirectory), /another project/);
  } finally { await f.close(); }
});

test('native close-all only closes owned project profiles, including profiles recovered by a new host', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const a = await f.automation.environment('project-a', '1', f.projectDirectory);
    const b = await f.automation.environment('project-b', '2', f.projectDirectory);
    await f.call(a, ['open']); await f.call(b, ['open']);
    const homes = (await f.calls()).map(call => call.home);
    await f.reopen();
    await f.automation.closeProject('project-a');
    await assert.rejects(readFile(join(homes[0], 'browser.json')), { code: 'ENOENT' });
    assert.ok(await readFile(join(homes[1], 'browser.json')));
    const calls = await f.calls();
    assert.ok(calls.some(call => call.args[0] === 'close-all' && call.cwd === f.projectDirectory && call.home === homes[0]));
    assert.ok(calls.every(call => !call.args.includes('kill-all')));
    await f.automation.closeAll();
    assert.deepEqual((await readdir(f.stateDirectory)).filter(name => name !== '.owner'), []);
    await assert.rejects(readFile(join(homes[1], 'browser.json')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('an absent or invalid bundled manifest does not fall back to a system browser or Node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pideck-automation-unavailable-'));
  try {
    const options = { resourcesDirectory: root, stateDirectory: join(root, 'state') };
    const absent = await Automation.open(options);
    assert.equal(absent.availability().available, false);
    assert.deepEqual(await absent.environment('project', '1'), {});
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ schema: 1, platform: process.platform, arch: process.arch,
      nodeVersion: '22.23.4', cliVersion: '0.1.23', playwrightVersion: '1.65.0-alpha-2026-10-30', browserRevision: '1252',
      node: '../outside', cli: '../outside', chromium: '../outside' }));
    assert.equal((await Automation.open(options)).availability().available, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resource relocation and OS temporary-directory reclamation preserve owned cleanup and retry', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const a = await f.automation.environment('project-a', '1', f.projectDirectory);
    await f.call(a, ['open']);
    const [initial] = await f.calls();
    await rm(initial.runtime, { recursive: true });
    await f.automation.environment('project-a', '1', f.projectDirectory);
    await f.call(a, ['snapshot']);
    const [, after] = await f.calls();
    assert.notEqual(after.runtime, initial.runtime);
    const moved = join(f.root, 'moved-resources');
    await rename(f.resourcesDirectory, moved);
    await f.reopen(moved);
    await f.automation.closeConversation('1');
    assert.deepEqual((await readdir(f.stateDirectory)).filter(name => name !== '.owner'), []);
  } finally { await f.close(); }
});

test('the standard Node shim executes the unpacked launcher beside an ASAR archive', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const archive = join(f.root, 'app.asar');
    await writeFile(archive, 'The archive is a file, not a Node-readable directory.');
    const unpacked = join(f.root, 'app.asar.unpacked', 'dist', 'automation');
    await mkdir(unpacked, { recursive: true });
    await rename(f.options.launcherPath, join(unpacked, 'cli.cjs'));
    f.options.launcherPath = join(archive, 'dist', 'automation', 'cli.cjs');
    await f.reopen();
    const env = await f.automation.environment('project', '1', f.projectDirectory);
    const result = await f.call(env, ['--help']);
    assert.deepEqual(JSON.parse(result.stdout).args, ['--help']);
    assert.deepEqual((await f.calls())[0].args, ['--help']);
  } finally { await f.close(); }
});

test('native cleanup handles the workspace hash of projects without a .playwright directory', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture(false);
  try {
    const env = await f.automation.environment('project', '1', f.projectDirectory);
    await f.call(env, ['open']);
    await f.reopen();
    await f.automation.closeConversation('1');
    const calls = await f.calls();
    assert.ok(calls.some(call => call.args[0] === 'close-all' && call.cwd === join(env.PATH.split(delimiter)[0], '..')));
    assert.deepEqual((await readdir(f.stateDirectory)).filter(name => name !== '.owner'), []);
  } finally { await f.close(); }
});

test('cleanup after host recovery succeeds when the OS already reclaimed the runtime directory', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const env = await f.automation.environment('project', '1', f.projectDirectory);
    await f.call(env, ['open']);
    const [initial] = await f.calls();
    await rm(initial.runtime, { recursive: true });
    await f.reopen();
    await f.automation.closeProject('project');
    await assert.rejects(readFile(join(initial.home, 'browser.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(initial.runtime, '.owner')), { code: 'ENOENT' });
    assert.deepEqual((await readdir(f.stateDirectory)).filter(name => name !== '.owner'), []);
  } finally { await f.close(); }
});

async function savedElectronProfile(f: Awaited<ReturnType<typeof fixture>>, env: Record<string, string>) {
  const directory = join(env.PATH.split(delimiter)[0], '..');
  const descriptor = join(directory, 'cli.json');
  const old = JSON.parse(await readFile(descriptor, 'utf8'));
  old.node = join(f.root, 'removed-Pideck.app', 'Contents', 'MacOS', 'Pideck');
  old.prelude = join(f.root, 'removed-node-prelude.cjs');
  old.npm = join(f.root, 'removed-npm-cli.js');
  old.npx = join(f.root, 'removed-npx-cli.js');
  await writeFile(descriptor, JSON.stringify(old));
  await writeFile(join(directory, 'bin', 'playwright-cli'),
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 NODE_OPTIONS=${quote(`--require=${old.prelude}`)} exec ${quote(old.node)} "$@"\n`, { mode: 0o700 });
  const fallback = join(directory, 'fallback-bin');
  await mkdir(fallback);
  for (const command of ['node', 'npm', 'npx']) {
    await writeFile(join(fallback, command), '#!/bin/sh\nexit 91\n', { mode: 0o700 });
  }
  return { old, descriptor, fallback };
}

test('an Electron-generation profile resumes its next command with standalone Node and keeps its native session', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const initial = await f.automation.environment('project', '1', f.projectDirectory);
    await f.call(initial, ['open']);
    const { old, descriptor, fallback } = await savedElectronProfile(f, initial);
    await f.reopen();
    const resumed = await f.automation.environment('project', '1', f.projectDirectory);
    const result = JSON.parse((await f.call(resumed, ['snapshot', '-s=existing-session'])).stdout);
    assert.deepEqual(result, { args: ['snapshot', '-s=existing-session'], home: old.home });
    const current = JSON.parse(await readFile(descriptor, 'utf8'));
    assert.equal(current.node, join(f.resourcesDirectory, 'node'));
    assert.equal(current.session, old.session);
    assert.equal(current.runtime, old.runtime);
    const projectNode = JSON.parse((await execute('/bin/sh', ['-c', 'node -p "JSON.stringify({electron:Boolean(process.versions.electron),defaultApp:Boolean(process.defaultApp),runAsNode:Boolean(process.env.ELECTRON_RUN_AS_NODE)})"'],
      { cwd: f.projectDirectory, env: { HOME: process.env.HOME, PATH: resumed.PATH } })).stdout);
    assert.deepEqual(projectNode, { electron: false, defaultApp: false, runAsNode: false });
    await f.automation.closeConversation('1');
    await assert.rejects(readFile(join(fallback, 'node')), { code: 'ENOENT' });
    assert.deepEqual((await readdir(f.stateDirectory)).filter(name => name !== '.owner'), []);
  } finally { await f.close(); }
});

test('an Electron-generation profile cleans up directly after reopen without preparing or invoking its old shim', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture(false);
  try {
    const env = await f.automation.environment('project', '1', f.projectDirectory);
    await f.call(env, ['open']);
    const { old, fallback } = await savedElectronProfile(f, env);
    await f.reopen();
    await f.automation.closeConversation('1');
    await assert.rejects(readFile(join(old.home, 'browser.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(fallback, 'node')), { code: 'ENOENT' });
    const calls = await f.calls();
    assert.equal(calls.filter(call => call.args[0] === 'open').length, 1);
    assert.ok(calls.some(call => call.args[0] === 'close-all' && call.home === old.home));
    assert.deepEqual((await readdir(f.stateDirectory)).filter(name => name !== '.owner'), []);
  } finally { await f.close(); }
});
