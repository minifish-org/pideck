import { resolve } from "node:path";
import type { FromHost, HostCloseResult, ToHost } from "../shared/transport";

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

type WorkspaceProcess = {
  on(event: "message", listener: (message: FromHost) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  removeListener(event: "message", listener: (message: FromHost) => void): unknown;
  removeListener(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: ToHost): void;
  kill(): boolean;
};

// An exit code alone cannot prove that SQLite, queue leases and PTYs closed.
// Require the worker's cleanup receipt, acknowledge it, then observe actual exit.
export function closeWorkspaceProcess(child: WorkspaceProcess, timeoutMs = 8_000, killTimeoutMs = 2_000): Promise<HostCloseResult> {
  return new Promise(resolve => {
    let complete = false;
    let receipt: Extract<FromHost, { type: "shutdown:complete" }> | undefined;
    let forced: "timeout" | "request-failed" | undefined;
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: HostCloseResult) => {
      if (complete) return;
      complete = true;
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      resolve(result);
    };
    const force = (reason: "timeout" | "request-failed") => {
      if (complete || forced) return;
      forced = reason;
      clearTimeout(deadline);
      try { child.kill(); } catch { /* The exit event or second deadline settles the result. */ }
      if (!complete) killDeadline = setTimeout(() => finish({ status: "forced", reason, exited: false }), killTimeoutMs);
    };
    const onMessage = (message: FromHost) => {
      if (message.type !== "shutdown:complete" || receipt || forced) return;
      receipt = message;
      try { child.postMessage({ type: "shutdown:exit" }); }
      catch { force("request-failed"); }
    };
    const onExit = (code: number) => {
      if (forced) finish({ status: "forced", reason: forced, exited: true });
      else if (receipt?.error) finish({ status: "failed", reason: "cleanup-failed", message: receipt.error });
      else if (!receipt || code !== 0) finish({ status: "failed", reason: "unexpected-exit", message: `The workspace exited without a clean shutdown (exit ${code}).` });
      else finish({ status: "graceful" });
    };
    const deadline = setTimeout(() => force("timeout"), timeoutMs);
    child.on("message", onMessage);
    child.once("exit", onExit);
    try { child.postMessage({ type: "shutdown" }); }
    catch { force("request-failed"); }
  });
}
