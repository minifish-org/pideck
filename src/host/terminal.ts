import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";
import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import type { HostEvent, TerminalEvent, TerminalOpen } from "../shared/api";
import { shellEnvironment } from "./shell-env";

type Terminal = {
  owner: number;
  projectId: string;
  pty: IPty;
  sequence: number;
  pending: string;
  backlog: TerminalEvent[];
  backlogSize: number;
  paused: boolean;
  exited: boolean;
  flush?: NodeJS.Timeout;
  subscriptions: { dispose(): void }[];
};
type ClosingShell = { pty: IPty; exited: Promise<void> };

const outputChunkSize = 32 * 1024;
const highWatermark = 256 * 1024;
const lowWatermark = highWatermark / 2;

function eventSize(event: TerminalEvent) {
  return 128 + (event.type === "terminal:data" ? event.data.length * 2 : 0);
}

function killShell(pty: IPty, signal: "SIGHUP" | "SIGKILL") {
  try { pty.kill(process.platform === "win32" ? undefined : signal); } catch { /* Shell already exited. */ }
}

export class Terminals {
  private terminals = new Map<string, Terminal>();
  private closing = new Map<string, Set<ClosingShell>>();

  constructor(private emit: (owner: number, event: HostEvent) => void) {}

  open(owner: number, projectId: string, cwd: string, cols: number, rows: number): TerminalOpen {
    if ([...this.terminals.values()].filter(terminal => terminal.owner === owner).length >= 4) {
      throw new Error("Close a terminal before opening another.");
    }
    const configuredShell = process.env.SHELL || userInfo().shell;
    const shell = process.platform === "win32" ? "powershell.exe"
      : configuredShell && isAbsolute(configuredShell) ? configuredShell : "/bin/sh";
    const args = ({
      zsh: ["-f"],
      bash: ["--noprofile", "--norc"],
      fish: ["--no-config"],
      "powershell.exe": ["-NoLogo", "-NoProfile"],
    } as Record<string, string[]>)[basename(shell)] ?? [];
    const terminalId = randomUUID();
    const pty = spawn(shell, args, {
      cwd,
      name: "xterm-256color",
      cols,
      rows,
      env: { ...shellEnvironment(), TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    const terminal: Terminal = {
      owner, projectId, pty, sequence: 0, pending: "", subscriptions: [],
      backlog: [], backlogSize: 0, paused: false, exited: false,
    };
    this.terminals.set(terminalId, terminal);

    const publish = (event: TerminalEvent) => {
      terminal.backlog.push(event);
      terminal.backlogSize += eventSize(event);
      if (!terminal.paused && !terminal.exited && terminal.backlogSize >= highWatermark) {
        pty.pause();
        terminal.paused = true;
      }
      this.emit(owner, event);
    };
    const flush = () => {
      clearTimeout(terminal.flush);
      terminal.flush = undefined;
      if (!terminal.pending) return;
      const data = terminal.pending;
      terminal.pending = "";
      publish({ type: "terminal:data", terminalId, projectId, sequence: ++terminal.sequence, data });
    };
    terminal.subscriptions.push(
      pty.onData(data => {
        terminal.pending += data;
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
    if (!terminal.exited) terminal.pty.write(data);
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
    for (const [id, terminal] of this.terminals) {
      if (terminal.owner === owner) this.remove(id, terminal);
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

  closeAll() {
    for (const shells of this.closing.values()) {
      for (const shell of shells) killShell(shell.pty, "SIGKILL");
    }
    for (const [id, terminal] of this.terminals) this.remove(id, terminal, true);
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
    clearTimeout(terminal.flush);
    terminal.flush = undefined;
    terminal.pending = "";
    terminal.backlog.length = 0;
    terminal.backlogSize = 0;
    for (const subscription of terminal.subscriptions.splice(0)) subscription.dispose();
    if (!terminal.exited) this.stopShell(terminal.projectId, terminal.pty, force);
  }

  private stopShell(projectId: string, pty: IPty, force: boolean) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const pending = this.closing.get(projectId) ?? new Set<ClosingShell>();
    const shell = { pty, exited: promise };
    pending.add(shell);
    this.closing.set(projectId, pending);
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
