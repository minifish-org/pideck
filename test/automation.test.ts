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
  const node = join(root, 'electron');
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
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,cwd:process.cwd(),home:process.env.HOME,runtime:process.env.XDG_RUNTIME_DIR,username:process.env.USERNAME,nodePath:process.env.PATH,executable:defaults.browser.launchOptions.executablePath,noUpdate:process.env.NO_UPDATE_NOTIFIER,runAsNode:process.env.ELECTRON_RUN_AS_NODE,defaultApp:process.defaultApp,nodeOptions:process.env.NODE_OPTIONS})+'\\n');
const state = path.join(process.env.HOME, 'browser.json');
const workspace = fs.existsSync(path.join(process.cwd(), '.playwright')) ? process.cwd() : '0123456789abcdef';
if (args[0] === 'open') fs.writeFileSync(state, JSON.stringify({workspace}));
if (args[0] === 'close-all') { try { if (JSON.parse(fs.readFileSync(state)).workspace === workspace) fs.unlinkSync(state); } catch {} }
if (args[0] === 'list') console.log(JSON.stringify({browsers:fs.existsSync(state)?[JSON.parse(fs.readFileSync(state))]:[]}));
else console.log(JSON.stringify({args,home:process.env.HOME}));
`);
  const npm = join(resourcesDirectory, 'npm-cli.js');
  const npx = join(resourcesDirectory, 'npx-cli.js');
  for (const file of [npm, npx]) await writeFile(file, `console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,runAsNode:process.env.ELECTRON_RUN_AS_NODE,defaultApp:process.defaultApp===true}));`);
  await writeFile(join(resourcesDirectory, 'manifest.json'), JSON.stringify({ schema: 2, platform: process.platform, arch: process.arch,
    runtime: 'electron', electronVersion: '45.2.3', cliVersion: '0.1.23', playwrightVersion: '1.65.0-alpha-2026-10-30', browserRevision: '1252',
    npm: 'npm-cli.js', cli: 'upstream.cjs', chromium: 'chromium' }));
  const launcherPath = join(root, 'cli.cjs');
  const preludePath = join(root, 'node prelude "quoted".cjs');
  await Promise.all([
    build({ entryPoints: ['src/automation/cli.ts'], outfile: launcherPath, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' }),
    build({ entryPoints: ['src/automation/node-prelude.ts'], outfile: preludePath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' }),
  ]);
  const options = { resourcesDirectory, stateDirectory, electronExecutable: node, launcherPath, preludePath };
  let automation = await Automation.open(options);
  const call = async (environment: Record<string, string>, args: string[]) => {
    const shim = join(environment.PATH.split(delimiter)[0], 'playwright-cli');
    return execute(shim, args, { cwd: projectDirectory, env: { ...process.env, ...environment } });
  };
  return { root, options, resourcesDirectory, stateDirectory, projectDirectory, call, upstreamSource: await readFile(cli, 'utf8'), get automation() { return automation; },
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
    await f.call({ ...a, NODE_OPTIONS: '--no-warnings' }, argv); await f.call(b, argv);
    const calls = await f.calls();
    assert.deepEqual(calls[0].args, argv);
    assert.equal(calls[0].cwd, f.projectDirectory);
    assert.notEqual(calls[0].home, process.env.HOME);
    assert.notEqual(calls[0].home, calls[1].home);
    assert.notEqual(calls[0].runtime, calls[1].runtime);
    assert.notEqual(calls[0].username, calls[1].username);
    assert.ok(Buffer.byteLength(join(calls[0].runtime, 'playwright', 'cli', '1234567890123456.sock')) < 104);
    assert.equal(calls[0].noUpdate, '1');
    assert.equal(calls[0].runAsNode, '1');
    assert.equal(calls[0].defaultApp, true, 'CLI-only preload is loaded even when its path contains spaces, apostrophes and quotes.');
    assert.ok(calls[0].nodeOptions.startsWith('--no-warnings '), 'Caller Node options survive the additional CLI preload.');
    assert.equal(calls[0].executable, join(f.resourcesDirectory, 'chromium'));
    assert.equal(await readFile(join(f.resourcesDirectory, 'upstream.cjs'), 'utf8'), f.upstreamSource, 'The original CLI is never rewritten.');
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
    assert.ok(calls.every(call => call.runAsNode === '1' && call.defaultApp === true), 'Cleanup uses the same Electron CLI-only environment.');
    await f.automation.closeAll();
    assert.deepEqual((await readdir(f.stateDirectory)).filter(name => name !== '.owner'), []);
    await assert.rejects(readFile(join(homes[1], 'browser.json')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('an absent or invalid bundled manifest does not fall back to a system browser or Node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pideck-automation-unavailable-'));
  try {
    const options = { resourcesDirectory: root, stateDirectory: join(root, 'state'), electronExecutable: process.execPath };
    const absent = await Automation.open(options);
    assert.equal(absent.availability().available, false);
    assert.deepEqual(await absent.environment('project', '1'), {});
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ schema: 2, platform: process.platform, arch: process.arch,
      runtime: 'electron', electronVersion: '45.2.3', cliVersion: '0.1.23', playwrightVersion: '1.65.0-alpha-2026-10-30', browserRevision: '1252',
      npm: '../outside', cli: '../outside', chromium: '../outside' }));
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

test('the executable shim loads its unpacked launcher and CLI preload beside an ASAR archive', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const archive = join(f.root, 'app.asar');
    await writeFile(archive, 'The archive is a file, not a Node-readable directory.');
    const unpacked = join(f.root, 'app.asar.unpacked', 'dist', 'automation');
    await mkdir(unpacked, { recursive: true });
    await rename(f.options.launcherPath, join(unpacked, 'cli.cjs'));
    await rename(f.options.preludePath, join(unpacked, 'node-prelude.cjs'));
    f.options.launcherPath = join(archive, 'dist', 'automation', 'cli.cjs');
    f.options.preludePath = join(archive, 'dist', 'automation', 'node-prelude.cjs');
    await f.reopen();
    const env = await f.automation.environment('project', '1', f.projectDirectory);
    const result = await f.call(env, ['--help']);
    assert.deepEqual(JSON.parse(result.stdout).args, ['--help']);
    assert.deepEqual((await f.calls())[0].args, ['--help']);
  } finally { await f.close(); }
});

test('existing project Node/npm/npx take precedence and fallback commands keep HOME without the CLI preload', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  const originalPath = process.env.PATH;
  try {
    const existing = join(f.root, 'existing-bin');
    await mkdir(existing);
    for (const command of ['node', 'npm', 'npx']) {
      await writeFile(join(existing, command), `#!/bin/sh\nprintf 'existing-${command}'\n`, { mode: 0o700 });
    }
    process.env.PATH = [existing, '/usr/bin', '/bin'].join(delimiter);
    const env = await f.automation.environment('project', '1', f.projectDirectory);
    const fallback = env.PATH.split(delimiter).at(-1)!;
    for (const command of ['node', 'npm', 'npx']) {
      const actual = await execute('/bin/sh', ['-c', command], { env: { ...process.env, ...env } });
      assert.equal(actual.stdout, `existing-${command}`);
    }
    const fallbackEnv = { ...process.env, PATH: [fallback, '/usr/bin', '/bin'].join(delimiter) };
    const node = JSON.parse((await execute(join(fallback, 'node'), ['-p', 'JSON.stringify({home:process.env.HOME,runAsNode:process.env.ELECTRON_RUN_AS_NODE,defaultApp:process.defaultApp===true})'], { env: fallbackEnv })).stdout);
    assert.deepEqual(node, { home: process.env.HOME, runAsNode: '1', defaultApp: false });
    for (const command of ['npm', 'npx']) {
      const actual = JSON.parse((await execute(join(fallback, command), ['argument with spaces', 'a"b'], { env: fallbackEnv })).stdout);
      assert.deepEqual(actual, { args: ['argument with spaces', 'a"b'], home: process.env.HOME, runAsNode: '1', defaultApp: false });
    }
  } finally {
    process.env.PATH = originalPath;
    await f.close();
  }
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

test('profiles from the standalone Node version retain their native session and cleanup after an upgrade', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const env = await f.automation.environment('project', '1', f.projectDirectory);
    await f.call(env, ['open']);
    const descriptor = join(env.PATH.split(delimiter)[0], '..', 'cli.json');
    const old = JSON.parse(await readFile(descriptor, 'utf8'));
    old.node = join(f.root, 'removed-standalone-node');
    delete old.prelude;
    await writeFile(descriptor, JSON.stringify(old));
    await f.reopen();
    await f.automation.closeConversation('1');
    const cleanup = (await f.calls()).slice(1);
    assert.ok(cleanup.length > 0 && cleanup.every(call => call.runAsNode === '1' && call.defaultApp === true));
    assert.deepEqual((await readdir(f.stateDirectory)).filter(name => name !== '.owner'), []);
  } finally { await f.close(); }
});
