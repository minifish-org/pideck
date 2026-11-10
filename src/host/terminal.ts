import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import { terminalIntegration } from "./terminal-integration";
import type { HostEvent, TerminalEvent, TerminalOpen } from "../shared/api";
import { terminalEnvironment } from "./shell-env";
import { captureTerminalSession, terminalHasNoJobs, terminalSessionGroups } from "./terminal-processes";

type Terminal = {
  owner?: number;
  projectId: string;
  pty: IPty;
  visible: boolean;
  lastUsed: number;
  inputVersion: number;
  atPrompt: boolean;
  pendingInput: boolean;
  integration: Awaited<ReturnType<typeof terminalIntegration>>;
  sequence: number;
  pending: string;
  backlog: TerminalEvent[];
  backlogSize: number;
  paused: boolean;
  exited: boolean;
  history: string[];
  historySize: number;
  historyTrimmed: boolean;
  flushOutput(): void;
  flush?: NodeJS.Timeout;
  subscriptions: { dispose(): void }[];
};
type ClosingShell = { pty: IPty; exited: Promise<void> };

const outputChunkSize = 32 * 1024;
const highWatermark = 256 * 1024;
const lowWatermark = highWatermark / 2;
const historyLimit = 1024 * 1024;

function eventSize(event: TerminalEvent) {
  return 128 + (event.type === "terminal:data" ? event.data.length * 2 : 0);
}

function killShell(pty: IPty, signal: "SIGHUP" | "SIGKILL") {
  try { pty.kill(process.platform === "win32" ? undefined : signal); } catch { /* Shell already exited. */ }
}

export class Terminals {
  private terminals = new Map<string, Terminal>();
  private closing = new Map<string, Set<ClosingShell>>();

  private readonly closedOwners = new Set<number>();
  private opening: Promise<unknown> = Promise.resolve();
  private sweeping: Promise<number> = Promise.resolve(0);
  private stopping = false;
  private readonly timer: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly idleAfter: number;
  private readonly hasNoJobs: (pid: number) => Promise<boolean>;
  private readonly cleanups = new Set<Promise<void>>();

  constructor(private emit: (owner: number, event: HostEvent) => void,
    options: { idleAfterMs?: number; scanEveryMs?: number; now?: () => number; hasNoJobs?: (pid: number) => Promise<boolean> } = {}) {
    this.now = options.now ?? Date.now;
    this.idleAfter = options.idleAfterMs ?? 30 * 60_000;
    this.hasNoJobs = options.hasNoJobs ?? terminalHasNoJobs;
    this.timer = setInterval(() => { void this.reclaimIdle().catch(() => {}); }, options.scanEveryMs ?? 60_000);
    this.timer.unref();
  }

  reclaimIdle(pressure = false): Promise<number> {
    const sweep = this.sweeping.catch(() => 0).then(async () => {
      let count = 0;
      const candidates = [...this.terminals].sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
      for (const [id, terminal] of candidates) {
        const version = terminal.inputVersion;
        const lastUsed = terminal.lastUsed;
        const eligible = () => !this.stopping && this.terminals.get(id) === terminal && !terminal.exited
          && !terminal.visible && terminal.atPrompt && !terminal.pendingInput
          && terminal.inputVersion === version && terminal.lastUsed === lastUsed && (pressure || this.now() - terminal.lastUsed >= this.idleAfter);
        if (!eligible() || !await this.hasNoJobs(terminal.pty.pid) || !eligible()) continue;
        const { owner, projectId } = terminal;
        const event: TerminalEvent = { type: 'terminal:reclaimed', projectId, terminalId: id, sequence: ++terminal.sequence };
        this.remove(id, terminal);
        if (owner !== undefined) this.emit(owner, event);
        await Promise.all([...(this.closing.get(projectId) ?? [])].map(shell => shell.exited));
        count++;
        // Under capacity pressure reclaim only the least-recently-used safe shell.
        if (pressure) break;
      }
      return count;
    });
    this.sweeping = sweep;
    return sweep;
  }

  visibility(owner: number, projectId: string, id: string, visible: boolean) {
    const terminal = this.find(owner, projectId, id);
    if (terminal.visible !== visible) terminal.lastUsed = this.now();
    terminal.visible = visible;
  }

  // This counts shells, including detached/closing ones, not foreground jobs.
  liveCount(): number {
    return [...this.terminals.values()].filter(terminal => !terminal.exited).length
      + [...this.closing.values()].reduce((count, shells) => count + shells.size, 0);
  }

  open(owner: number, projectId: string, cwd: string, cols: number, rows: number): Promise<TerminalOpen> {
    const configuredShell = process.env.SHELL || userInfo().shell;
    const shell = process.platform === 'win32' ? 'powershell.exe'
      : configuredShell && isAbsolute(configuredShell) ? configuredShell : '/bin/sh';
    const env = terminalEnvironment();
    const result = this.opening.catch(() => {}).then(() => this.performOpen(owner, projectId, cwd, cols, rows, shell, env));
    this.opening = result;
    return result;
  }

  private async performOpen(owner: number, projectId: string, cwd: string, cols: number, rows: number,
    shell: string, env: Record<string, string>): Promise<TerminalOpen> {
    const requireOwner = () => { if (this.stopping || this.closedOwners.has(owner)) throw new Error('This terminal window is no longer open.'); };
    requireOwner();
    await this.reclaimIdle();
    requireOwner();
    for (const [terminalId, terminal] of this.terminals) {
      if (terminal.projectId !== projectId || (terminal.owner !== undefined && terminal.owner !== owner)) continue;
      // Renderer/window lifetime does not own the shell. Reattach without replaying input.
      terminal.flushOutput();
      terminal.owner = owner;
      terminal.visible = true;
      terminal.lastUsed = this.now();
      terminal.backlog.length = 0;
      terminal.backlogSize = 0;
      if (terminal.paused && !terminal.exited) {
        terminal.paused = false;
        terminal.pty.resume();
      }
      if (!terminal.exited) terminal.pty.resize(cols, rows);
      const data = (terminal.historyTrimmed ? "[Earlier terminal output omitted]\r\n" : "") + terminal.history.join("");
      return { terminalId, data, sequence: terminal.sequence, exited: terminal.exited };
    }
    if (this.liveCount() >= 4) await this.reclaimIdle(true);
    requireOwner();
    if (this.liveCount() >= 4) {
      throw new Error('Four project shells are busy. Exit one before opening another.');
    }
    const integration = await terminalIntegration(shell, env);
    if (this.stopping || this.closedOwners.has(owner)) {
      await integration.dispose();
      requireOwner();
    }
    // macOS Terminal starts a login shell. Other Unix terminals normally load interactive profiles.
    const interactiveArgs = process.platform === "darwin" ? ["-l", "-i"] : ["-i"];
    const args = process.platform === "win32" ? ["-NoLogo"]
      : ["zsh", "bash", "fish"].includes(basename(shell)) ? interactiveArgs : [];
    const terminalId = randomUUID();
    let pty: IPty;
    try { pty = spawn(shell, args, {
      cwd,
      name: "xterm-256color",
      cols,
      rows,
      env: { ...integration.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    }); } catch (error) { await integration.dispose(); throw error; }
    const terminal: Terminal = {
      owner, projectId, pty, integration, visible: true, lastUsed: this.now(), inputVersion: 0, atPrompt: false, pendingInput: false, sequence: 0, pending: "", subscriptions: [],
      backlog: [], backlogSize: 0, paused: false, exited: false,
      history: [], historySize: 0, historyTrimmed: false, flushOutput: () => {},
    };
    this.terminals.set(terminalId, terminal);

    const publish = (event: TerminalEvent) => {
      if (event.type === "terminal:data") {
        terminal.history.push(event.data);
        terminal.historySize += event.data.length;
        while (terminal.historySize > historyLimit && terminal.history.length) {
          const excess = terminal.historySize - historyLimit;
          const first = terminal.history[0];
          if (first.length <= excess) {
            terminal.history.shift();
            terminal.historySize -= first.length;
          } else {
            // Prefer a line boundary so a restored screen does not begin inside ANSI text.
            const newline = first.indexOf("\n", excess);
            const cut = newline >= 0 ? newline + 1 : excess;
            terminal.history[0] = first.slice(cut);
            terminal.historySize -= cut;
          }
          terminal.historyTrimmed = true;
        }
      }
      // Keep draining detached shells, including servers that keep writing while the
      // window is closed. Only a connected screen applies acknowledgement backpressure.
      if (terminal.owner === undefined) return;
      terminal.backlog.push(event);
      terminal.backlogSize += eventSize(event);
      if (!terminal.paused && !terminal.exited && terminal.backlogSize >= highWatermark) {
        pty.pause();
        terminal.paused = true;
      }
      this.emit(terminal.owner, event);
    };
    const flush = () => {
      clearTimeout(terminal.flush);
      terminal.flush = undefined;
      if (!terminal.pending) return;
      const data = terminal.pending;
      terminal.pending = "";
      publish({ type: "terminal:data", terminalId, projectId, sequence: ++terminal.sequence, data });
    };
    terminal.flushOutput = flush;
    terminal.subscriptions.push(
      pty.onData(data => {
        const parsed = integration.parse(data);
        if (parsed.prompt !== undefined) terminal.atPrompt = parsed.prompt;
        terminal.lastUsed = this.now();
        terminal.pending += parsed.text;
        if (terminal.pending.length >= outputChunkSize) flush();
        else terminal.flush ??= setTimeout(flush, 16);
      }),
      pty.onExit(({ exitCode }) => {
        terminal.exited = true;
        flush();
        publish({ type: "terminal:exit", terminalId, projectId, sequence: ++terminal.sequence, exitCode });
        for (const subscription of terminal.subscriptions.splice(0)) subscription.dispose();
      }),
    );
    return { terminalId, data: "", sequence: 0, exited: false };
  }

  input(owner: number, projectId: string, id: string, data: string) {
    const terminal = this.find(owner, projectId, id);
    if (!terminal.exited) {
      terminal.lastUsed = this.now();
      terminal.inputVersion++;
      terminal.atPrompt = false;
      for (const character of data) {
        terminal.pendingInput = !['\r', '\n', '\x03', '\x04'].includes(character);
      }
      terminal.pty.write(data);
    }
  }

  resize(owner: number, projectId: string, id: string, cols: number, rows: number) {
    const terminal = this.find(owner, projectId, id);
    if (!terminal.exited && (terminal.pty.cols !== cols || terminal.pty.rows !== rows)) terminal.pty.resize(cols, rows);
  }

  sync(owner: number, projectId: string, id: string, through: number, replay?: true): TerminalEvent[] {
    const terminal = this.find(owner, projectId, id);
    if (through > terminal.sequence) throw new Error("The terminal output cursor is invalid.");
    let acknowledged = 0;
    for (const event of terminal.backlog) {
      if (event.sequence > through) break;
      terminal.backlogSize -= eventSize(event);
      acknowledged++;
    }
    terminal.backlog.splice(0, acknowledged);
    if (terminal.exited && terminal.backlog.length === 0) this.remove(id, terminal);
    else if (terminal.paused && !terminal.exited && terminal.backlogSize <= lowWatermark) {
      terminal.paused = false;
      terminal.pty.resume();
    }
    return replay ? [...terminal.backlog] : [];
  }

  close(owner: number, projectId: string, id: string) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    this.remove(id, this.find(owner, projectId, id));
  }

  closeOwner(owner: number) {
    this.closedOwners.add(owner);
    for (const terminal of this.terminals.values()) {
      if (terminal.owner !== owner) continue;
      terminal.owner = undefined;
      terminal.visible = false;
      terminal.lastUsed = this.now();
      terminal.backlog.length = 0;
      terminal.backlogSize = 0;
      if (terminal.paused && !terminal.exited) {
        terminal.paused = false;
        terminal.pty.resume();
      }
    }
  }

  async closeProject(projectId: string): Promise<void> {
    for (const [id, terminal] of this.terminals) {
      if (terminal.projectId === projectId) this.remove(id, terminal);
    }
    const pending = this.closing.get(projectId);
    if (!pending?.size) return;
    const timeout = Promise.withResolvers<never>();
    const deadline = setTimeout(() => timeout.reject(new Error("The project terminal did not stop. Try removing it again.")), 5_000);
    try {
      await Promise.race([Promise.all([...pending].map(shell => shell.exited)), timeout.promise]);
    } finally {
      clearTimeout(deadline);
    }
  }

  async closeAll() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.opening.catch(() => {});
    await this.sweeping.catch(() => {});
    for (const [id, terminal] of this.terminals) this.remove(id, terminal, true);
    await Promise.all([...this.closing.values()].flatMap(shells => [...shells].map(shell => shell.exited)));
    await Promise.all(this.cleanups);
  }

  private find(owner: number, projectId: string, id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.owner !== owner || terminal.projectId !== projectId) {
      throw new Error("This terminal is no longer open for this project.");
    }
    return terminal;
  }

  private remove(id: string, terminal: Terminal, force = false) {
    this.terminals.delete(id);
    const cleanup = terminal.integration.dispose().catch(() => {});
    this.cleanups.add(cleanup);
    void cleanup.finally(() => this.cleanups.delete(cleanup));
    clearTimeout(terminal.flush);
    terminal.flush = undefined;
    terminal.pending = "";
    terminal.backlog.length = 0;
    terminal.backlogSize = 0;
    terminal.history.length = 0;
    terminal.historySize = 0;
    for (const subscription of terminal.subscriptions.splice(0)) subscription.dispose();
    if (!terminal.exited) this.stopShell(terminal.projectId, terminal.pty, force);
  }

  private stopShell(projectId: string, pty: IPty, force: boolean) {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    // An explicit restart does not await teardown; project removal/shutdown do.
    void promise.catch(() => {});
    const pending = this.closing.get(projectId) ?? new Set<ClosingShell>();
    const shell = { pty, exited: promise };
    pending.add(shell);
    this.closing.set(projectId, pending);
    if (process.platform === "linux") {
      let exited = false;
      const exit = Promise.withResolvers<void>();
      const subscription = pty.onExit(() => {
        exited = true;
        subscription.dispose();
        exit.resolve();
      });
      void (async () => {
        const session = await captureTerminalSession(pty.pid);
        const signal = async (value: "SIGHUP" | "SIGKILL") => {
          if (!session) {
            if (!exited) killShell(pty, value);
            return;
          }
          for (const group of await terminalSessionGroups(session)) {
            try { process.kill(-group, value); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          }
        };
        await signal(force ? "SIGKILL" : "SIGHUP");
        if (!force) {
          // dash does not forward HUP to jobs; jobs may also ignore HUP. Keep
          // this pass even if the shell exits first, and discover groups afresh.
          await delay(250);
          await signal("SIGKILL");
        }
        await exit.promise;
      })().then(resolve, reject).finally(() => {
        pending.delete(shell);
        if (!pending.size) this.closing.delete(projectId);
      });
      return;
    }
    const graceful = process.platform !== "win32" && !force;
    // Let interactive shells send SIGHUP to their jobs before forcing teardown.
    const fallback = graceful ? setTimeout(() => killShell(pty, "SIGKILL"), 250) : undefined;
    const exit = pty.onExit(() => {
      clearTimeout(fallback);
      exit.dispose();
      pending.delete(shell);
      if (!pending.size) this.closing.delete(projectId);
      resolve();
    });
    killShell(pty, graceful ? "SIGHUP" : "SIGKILL");
  }
}
