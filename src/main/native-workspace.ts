import { resolve } from "node:path";

// OS launch arguments are entry points, never shell commands. Ignore switches
// and their values (including Electron's profile/debugging paths).
export function projectArguments(args: readonly string[], cwd: string): string[] {
  const directories: string[] = [];
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (!positional && argument === "--") { positional = true; continue; }
    if (!positional && argument.startsWith("-")) {
      if (!argument.includes("=") && args[i + 1] && !args[i + 1].startsWith("-")) i++;
      continue;
    }
    if (!argument || argument.includes("\0")) continue;
    const directory = resolve(cwd, argument);
    if (!directories.includes(directory)) directories.push(directory);
  }
  return directories;
}

export function workspaceTitle(project?: { name: string }, session?: { title: string }) {
  const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return [session && clean(session.title), project && clean(project.name), "Pideck"].filter(Boolean).join(" — ");
}

// Coalesce repeated Cmd+Q while the native sheet is open. Idle quits do not
// prompt; only an explicit destructive choice lets the host shutdown proceed.
export class QuitGuard {
  private pending?: Promise<boolean>;
  constructor(private readonly hasActiveWork: () => Promise<boolean>, private readonly confirm: () => Promise<boolean>) {}

  request() {
    if (this.pending) return this.pending;
    const pending = this.hasActiveWork().then(active => !active || this.confirm())
      .finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    return pending;
  }
}
