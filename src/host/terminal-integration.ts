import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Prompt/command markers are used only as a conservative lifecycle hint. A
// separate OS process check must also prove there are no foreground/background jobs.
export async function terminalIntegration(shell: string, environment: Record<string, string>) {
  const token = randomUUID();
  const prefix = `\x1b]133;Pideck;${token};`;
  const ready = `printf '\\033]133;Pideck;${token};prompt\\007'`;
  const active = `printf '\\033]133;Pideck;${token};active\\007'`;
  const env = { ...environment };
  let dispose = async () => {};
  let supported = false;
  if (basename(shell) === 'zsh') {
    const directory = await mkdtemp(join(tmpdir(), 'pideck-shell-'));
    dispose = () => rm(directory, { recursive: true, force: true });
    const source = `
function __pideck_source() {
  if (( __pideck_zdotdir_set )); then ZDOTDIR=$__pideck_zdotdir; else unset ZDOTDIR; fi
  [[ -r "$__pideck_zdotdir/$1" ]] && builtin source "$__pideck_zdotdir/$1"
  __pideck_zdotdir_set=\${+ZDOTDIR}
  __pideck_zdotdir=\${ZDOTDIR:-$HOME}
  ZDOTDIR=${quote(directory)}
}
`;
    const hooks = `
function __pideck_ready() { ${ready}; }
function __pideck_active() { ${active}; }
typeset -ga precmd_functions preexec_functions
precmd_functions=(\${precmd_functions:#__pideck_ready} __pideck_ready)
preexec_functions=(__pideck_active \${preexec_functions:#__pideck_active})
`;
    const restore = 'if (( __pideck_zdotdir_set )); then ZDOTDIR=$__pideck_zdotdir; else unset ZDOTDIR; fi\n';
    try {
      await Promise.all([
        ['.zshenv', `typeset -g __pideck_zdotdir=${quote(env.ZDOTDIR || env.HOME || '')}\ntypeset -gi __pideck_zdotdir_set=${env.ZDOTDIR ? 1 : 0}\n${source}\n__pideck_source .zshenv\n`],
        ['.zprofile', '__pideck_source .zprofile\n'],
        ['.zshrc', `__pideck_source .zshrc\n${hooks}\nif [[ ! -o login ]]; then ${restore}fi\n`],
        ['.zlogin', `__pideck_source .zlogin\n${hooks}\n${restore}`],
      ].map(([file, contents]) => writeFile(join(directory, file), contents, { mode: 0o600 })));
    } catch (error) { await dispose(); throw error; }
    env.ZDOTDIR = directory;
    supported = true;
  } else if (basename(shell) === 'bash' && !env.PROMPT_COMMAND) {
    // Respect a profile that supplies its own PROMPT_COMMAND/DEBUG hook: if it
    // replaces our hint we cannot establish idle, so that shell is never recycled.
    env.PROMPT_COMMAND = `if [[ -z $(trap -p DEBUG) ]]; then trap ${quote(active)} DEBUG; fi; if [[ $(trap -p DEBUG) == *${quote(token)}* ]]; then ${ready}; fi`;
    supported = true;
  }
  let pending = '';
  function parse(data: string): { text: string; prompt?: boolean } {
    if (!supported) return { text: data };
    pending += data;
    let text = '';
    let prompt: boolean | undefined;
    while (pending) {
      const start = pending.indexOf(prefix);
      if (start < 0) {
        let keep = 0;
        for (let size = Math.min(prefix.length - 1, pending.length); size > 0; size--) {
          if (pending.endsWith(prefix.slice(0, size))) { keep = size; break; }
        }
        text += pending.slice(0, pending.length - keep);
        pending = keep ? pending.slice(-keep) : '';
        break;
      }
      text += pending.slice(0, start);
      pending = pending.slice(start);
      const end = pending.indexOf('\x07', prefix.length);
      if (end < 0 && pending.length < prefix.length + 32) break;
      if (end < 0 || end > prefix.length + 32) { text += pending[0]; pending = pending.slice(1); continue; }
      const state = pending.slice(prefix.length, end);
      if (state === 'prompt') prompt = true;
      else if (state === 'active') prompt = false;
      else text += pending.slice(0, end + 1);
      pending = pending.slice(end + 1);
    }
    return { text, ...(prompt === undefined ? {} : { prompt }) };
  }
  return { env, parse, dispose };
}
