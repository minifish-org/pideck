import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { cliEnvironment, type AutomationProfile } from './profile.js';

// The host creates the descriptor and executable shim. Everything after it is
// the upstream CLI's original argv, including its native configuration flags.
export async function runCli(descriptor: string, argv: string[]) {
  const profile = JSON.parse(readFileSync(descriptor, 'utf8')) as AutomationProfile;
  if (profile.schema !== 1 || !profile.node || !profile.cli || !profile.playwright || !profile.home) throw new Error('Browser tools are unavailable.');
  const env = cliEnvironment(profile);
  // This launcher is already a dedicated subprocess. The upstream resolver
  // reads os.homedir() as well as its env argument, so both must see the same
  // private CLI home. The calling shell and its npm HOME remain unchanged.
  for (const [name, value] of Object.entries(env)) if (value !== undefined) process.env[name] = value;
  let child: ReturnType<typeof spawn> | undefined;
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const forward = (signal: typeof signals[number]) => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
    else propagate(signal);
  };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  const propagate = (signal: NodeJS.Signals) => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    process.kill(process.pid, signal);
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const execute = (args: string[], preparing = false) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child = spawn(profile.node, args, { env, stdio: preparing ? ['inherit', 2, 2] : 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    // Use the pinned CLI's own argument parser, including global flags before
    // the command. Help, metadata, attaching and closing never trigger downloads.
    const require = createRequire(profile.playwright);
    const client = join(dirname(profile.playwright), '..', 'playwright-core', 'lib', 'tools', 'cli-client');
    const { minimist } = require(join(client, 'minimist.js'));
    const help = require(join(client, 'help.json'));
    const args = minimist(argv, { boolean: [...help.booleanOptions, 'all', 'g', 'help', 'json', 'raw', 'version'], string: ['_'] });
    let install: string | undefined;
    if (!args.help && !args.h && !args.version && !args.v && args._?.[0] === 'video-start') install = 'ffmpeg';
    if (args._?.[0] === 'open' && !args.help && !args.h && !args.version && !args.v) {
      const { tools } = require(join(dirname(profile.playwright), '..', 'playwright-core', 'lib', 'coreBundle.js'));
      // Leave invalid configuration diagnostics to the original CLI rather
      // than replacing them with a setup/reinstall error.
      const config = await tools.resolveCLIConfigForCLI(profile.runtime, profile.session, args, env).catch(() => undefined);
      const browser = config?.browser;
      if (browser && !config.extension && !browser.remoteEndpoint && !browser.cdpEndpoint && !browser.launchOptions.executablePath) {
        const channel = browser.launchOptions.channel;
        // Native channel overrides (Chrome, Edge, Firefox channels) refer to
        // user-installed browsers. Only prepare Playwright-managed targets.
        if (browser.browserName === 'chromium' && (!channel || channel === 'chromium' || channel === 'chrome-for-testing')) install = 'chromium';
        else if (browser.browserName === 'firefox' && !channel) install = 'firefox';
        else if (browser.browserName === 'webkit') install = 'webkit';
      }
    }
    if (install) {
      // The upstream installer supplies its own locking, cache validation,
      // platform selection and download handling. Never republish its binaries.
      const installed = await execute([profile.playwright, 'install', install, '--no-progress', '--no-remove'], true);
      if (installed.signal) { propagate(installed.signal); return; }
      if (installed.code !== 0) {
        console.error('Browser setup could not finish. Check your connection and retry the same command.');
        process.exitCode = installed.code ?? 1;
        return;
      }
    }
    const result = await execute([profile.cli, ...argv]);
    if (result.signal) propagate(result.signal);
    else process.exitCode = result.code ?? 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

if (process.argv[2]) {
  void runCli(process.argv[2], process.argv.slice(3)).catch(() => {
    console.error('Pideck browser tools could not start. Rebuild or reinstall Pideck.');
    process.exitCode = 1;
  });
}
