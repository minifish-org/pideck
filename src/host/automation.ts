import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { shellEnvironment } from './shell-env.js';
import { cliEnvironment, type AutomationProfile } from '../automation/profile.js';

const execute = promisify(execFile);
const manifestVersion = { schema: 2, nodeVersion: '22.23.4', npmVersion: '12.2.2', cliVersion: '0.1.23',
  playwrightVersion: '1.65.0-alpha-2026-10-30', browserRevision: '1252' };
type Manifest = typeof manifestVersion & { platform: string; arch: string; node: string; cli: string; playwright: string };
type Options = { resourcesDirectory: string; stateDirectory: string; launcherPath?: string };
type Profile = { directory: string; descriptor: string; value: AutomationProfile };

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const unavailable = 'Bundled browser tools are unavailable. Rebuild or reinstall Pideck before browser verification.';

async function ownedDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error(unavailable);
}

async function atomicWrite(path: string, contents: string, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function resource(root: string, value: unknown) {
  if (typeof value !== 'string' || !value || value.includes('\0') || isAbsolute(value)
    || value.split(/[\\/]/).some(part => part === '..')) throw new Error(unavailable);
  const file = await realpath(resolve(root, value));
  if (relative(root, file).startsWith('..') || isAbsolute(relative(root, file)) || !(await lstat(file)).isFile()) throw new Error(unavailable);
  return file;
}

export class Automation {
  private readonly profiles = new Map<string, Profile>();
  private readonly preparing = new Map<string, Promise<Profile>>();
  private readonly closing = new Map<string, Promise<void>>();

  private constructor(private readonly options: Options, private readonly owner: string,
    private readonly paths?: { node: string; cli: string; playwright: string; browsers: string }, private readonly reason?: string) {}

  static async open(options: Options): Promise<Automation> {
    let paths: Automation['paths'];
    try {
      const root = await realpath(options.resourcesDirectory);
      const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Manifest;
      if (Object.entries(manifestVersion).some(([key, value]) => manifest[key as keyof Manifest] !== value)
        || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error(unavailable);
      const [node, cli, playwright] = await Promise.all([resource(root, manifest.node), resource(root, manifest.cli), resource(root, manifest.playwright)]);
      await access(node, constants.X_OK);
      paths = { node, cli, playwright, browsers: join(options.stateDirectory, 'browsers') };
    } catch { return new Automation(options, '', undefined, unavailable); }
    await ownedDirectory(options.stateDirectory);
    const ownerFile = join(options.stateDirectory, '.owner');
    await writeFile(ownerFile, randomUUID(), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(ownerFile)).isFile()) throw new Error(unavailable);
    const owner = await readFile(ownerFile, 'utf8');
    if (!/^[0-9a-f-]{36}$/i.test(owner)) throw new Error(unavailable);
    const automation = new Automation(options, owner, paths);
    for (const entry of await readdir(options.stateDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
      const directory = join(options.stateDirectory, entry.name);
      try {
        const value = JSON.parse(await readFile(join(directory, 'cli.json'), 'utf8')) as AutomationProfile;
        if (value.owner !== owner || value.schema !== 1 || entry.name !== hash(`${value.projectId}/${value.conversationId}`)
          || value.home !== join(directory, 'home') || value.output !== join(directory, 'output')) continue;
        automation.profiles.set(value.conversationId, { directory, descriptor: join(directory, 'cli.json'), value: { ...value, ...paths } });
      } catch { /* A partially written profile has never started a CLI. */ }
    }
    return automation;
  }

  availability() { return { available: Boolean(this.paths), ...(this.reason ? { reason: this.reason } : {}) }; }

  instructions() {
    return this.paths
      ? 'Pideck provides playwright-cli and Node/npm on PATH. Use playwright-cli directly. The first browser open automatically downloads the pinned upstream browser and FFmpeg into application data; allow a longer bash timeout for this first download. Later opens reuse the cache. Browser sessions and output are isolated to this conversation. Read screenshot paths with the read tool when the model supports images. Close browsers with playwright-cli close when finished; never use kill-all.'
      : unavailable;
  }

  async environment(projectId: string, conversationId: string, projectDirectory = process.cwd()): Promise<Record<string, string>> {
    if (!this.paths) return {};
    await this.closing.get(conversationId);
    let pending = this.preparing.get(conversationId);
    if (!pending) {
      pending = this.prepare(projectId, conversationId, projectDirectory);
      this.preparing.set(conversationId, pending);
      void pending.finally(() => { if (this.preparing.get(conversationId) === pending) this.preparing.delete(conversationId); }).catch(() => {});
    }
    const profile = await pending;
    if (profile.value.projectId !== projectId) throw new Error('Browser session belongs to another project.');
    return { PATH: [join(profile.directory, 'bin'), dirname(this.paths.node), shellEnvironment().PATH ?? ''].filter(Boolean).join(delimiter) };
  }

  private async prepare(projectId: string, conversationId: string, projectDirectory: string): Promise<Profile> {
    if (!projectId || !conversationId || projectId.length > 200 || conversationId.length > 200) throw new Error(unavailable);
    let profile = this.profiles.get(conversationId);
    if (profile && profile.value.projectId !== projectId) throw new Error('Browser session belongs to another project.');
    if (!profile) {
      const directory = join(this.options.stateDirectory, hash(`${projectId}/${conversationId}`));
      await ownedDirectory(directory);
      // Keep Unix socket paths below macOS's limit, even for a long app-data path.
      const runtime = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'pideck-browser-'));
      await writeFile(join(runtime, '.owner'), this.owner, { mode: 0o600 });
      const value: AutomationProfile = { schema: 1, owner: this.owner, projectId, conversationId, projectDirectory,
        ...this.paths!, home: join(directory, 'home'), output: join(directory, 'output'), runtime,
        session: `pideck-${hash(`${this.owner}/${projectId}/${conversationId}`)}` };
      profile = { directory, descriptor: join(directory, 'cli.json'), value };
      this.profiles.set(conversationId, profile);
    }
    profile.value.projectDirectory = projectDirectory;
    await this.requireRuntime(profile.value.runtime).catch(async error => {
      if (error.code !== 'ENOENT') throw error;
      profile.value.runtime = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'pideck-browser-'));
      await writeFile(join(profile.value.runtime, '.owner'), this.owner, { mode: 0o600 });
    });
    await Promise.all([ownedDirectory(profile.value.home), ownedDirectory(profile.value.output), ownedDirectory(join(profile.directory, 'bin'))]);
    const configDirectory = join(profile.value.home, '.playwright');
    await ownedDirectory(configDirectory);
    await atomicWrite(join(configDirectory, 'cli.config.json'), JSON.stringify({
      browser: { browserName: 'chromium', launchOptions: { channel: 'chromium', headless: true } },
      outputDir: profile.value.output, filePaths: 'absolute',
    }));
    await atomicWrite(profile.descriptor, JSON.stringify(profile.value));
    // This shim uses standard Node, which cannot traverse Electron's virtual
    // ASAR filesystem. The packaged launcher is explicitly unpacked at build.
    const launcher = (this.options.launcherPath ?? fileURLToPath(new URL('../automation/cli.cjs', import.meta.url)))
      .replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked');
    const shim = `#!/bin/sh\nexec ${quote(this.paths!.node)} ${quote(launcher)} ${quote(profile.descriptor)} "$@"\n`;
    await atomicWrite(join(profile.directory, 'bin', 'playwright-cli'), shim, 0o700);
    if (process.platform === 'win32') {
      const cmdQuote = (value: string) => `"${value.replaceAll('%', '%%')}"`;
      await atomicWrite(join(profile.directory, 'bin', 'playwright-cli.cmd'), `@${[this.paths!.node, launcher, profile.descriptor].map(cmdQuote).join(' ')} %*\r\n`, 0o700);
    }
    return profile;
  }

  private async requireRuntime(runtime: string, allowMissing = false) {
    const parent = process.platform === 'win32' ? tmpdir() : '/tmp';
    if (dirname(runtime) !== parent || !basename(runtime).startsWith('pideck-browser-')) throw new Error(unavailable);
    const entry = await lstat(runtime).catch(error => {
      if (allowMissing && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (entry && (!entry.isDirectory() || await readFile(join(runtime, '.owner'), 'utf8') !== this.owner)) throw new Error(unavailable);
  }

  private async cli(profile: Profile, args: string[], cwd: string, signal: AbortSignal) {
    return execute(this.paths!.node, [this.paths!.cli, ...args], {
      cwd, env: cliEnvironment(profile.value, shellEnvironment()), signal, timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
  }

  async closeConversation(conversationId: string): Promise<void> {
    const existing = this.closing.get(conversationId);
    if (existing) return existing;
    const result = this.closeProfile(conversationId);
    this.closing.set(conversationId, result);
    try { await result; }
    finally { if (this.closing.get(conversationId) === result) this.closing.delete(conversationId); }
  }

  private async closeProfile(conversationId: string): Promise<void> {
    await this.preparing.get(conversationId);
    const profile = this.profiles.get(conversationId);
    if (!profile || !this.paths) return;
    // Upstream monitors Unix socket removal and exits its daemon. Still inspect
    // the private registry when the OS has already reclaimed this directory.
    await this.requireRuntime(profile.value.runtime, true);
    const signal = AbortSignal.timeout(6_000);
    const list = JSON.parse((await this.cli(profile, ['list', '--all', '--json'], profile.directory, signal)).stdout) as {
      browsers: { workspace?: string }[];
    };
    if (!Array.isArray(list.browsers)) throw new Error('Browser sessions could not be inspected.');
    // Without a .playwright workspace, upstream reports a package-root hash,
    // not a directory. A neutral owned cwd selects that same native fallback.
    const workspaces = new Set(list.browsers.map(browser => browser.workspace && isAbsolute(browser.workspace)
      ? browser.workspace : profile.directory));
    for (const cwd of workspaces) await this.cli(profile, ['close-all'], cwd, signal);
    const remaining = JSON.parse((await this.cli(profile, ['list', '--all', '--json'], profile.directory, signal)).stdout) as { browsers?: unknown[] };
    if (!Array.isArray(remaining.browsers) || remaining.browsers.length) throw new Error('A browser session could not be closed.');
    const stored = JSON.parse(await readFile(profile.descriptor, 'utf8')) as AutomationProfile;
    if (['schema', 'owner', 'projectId', 'conversationId', 'home', 'runtime', 'output'].some(key =>
      stored[key as keyof AutomationProfile] !== profile.value[key as keyof AutomationProfile])) throw new Error('Browser session ownership changed.');
    await rm(profile.value.runtime, { recursive: true, force: true });
    await rm(profile.directory, { recursive: true });
    this.profiles.delete(conversationId);
  }

  async closeProject(projectId: string) {
    await Promise.all([...this.preparing.values()]);
    await Promise.all([...this.profiles].filter(([, profile]) => profile.value.projectId === projectId).map(([id]) => this.closeConversation(id)));
  }

  async closeAll() {
    await Promise.all([...this.preparing.values()]);
    await Promise.all([...this.profiles.keys()].map(id => this.closeConversation(id)));
  }
}
