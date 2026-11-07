import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { cliEnvironment, type AutomationProfile } from './profile.js';

// The host creates the descriptor and executable shim. Everything after it is
// the upstream CLI's original argv, including its native configuration flags.
export async function runCli(descriptor: string, argv: string[]) {
  const profile = JSON.parse(readFileSync(descriptor, 'utf8')) as AutomationProfile;
  if (profile.schema !== 1 || !profile.node || !profile.cli || !profile.home) throw new Error('Browser tools are unavailable.');
  const child = spawn(profile.node, [profile.cli, ...argv], { env: cliEnvironment(profile), stdio: 'inherit', windowsHide: true });
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const forward = (signal: typeof signals[number]) => child.kill(signal);
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (result.signal) process.kill(process.pid, result.signal);
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
