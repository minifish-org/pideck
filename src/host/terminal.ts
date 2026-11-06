import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";
import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import type { HostEvent, TerminalOpen } from "../shared/api";
import { shellEnvironment } from "./shell-env";

type Terminal = {
  owner: number;
  projectId: string;
  pty: IPty;
  sequence: number;
  pending: string;
  flush?: NodeJS.Timeout;
  subscriptions: { dispose(): void }[];
};

export class Terminals {
  private terminals = new Map<string, Terminal>();

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
    const terminal: Terminal = { owner, projectId, pty, sequence: 0, pending: "", subscriptions: [] };
    this.terminals.set(terminalId, terminal);

    const flush = () => {
      clearTimeout(terminal.flush);
      terminal.flush = undefined;
      if (!terminal.pending) return;
      const data = terminal.pending;
      terminal.pending = "";
      this.emit(owner, { type: "terminal:data", terminalId, projectId, sequence: ++terminal.sequence, data });
    };
    terminal.subscriptions.push(
      pty.onData(data => {
        terminal.pending += data;
        if (terminal.pending.length >= 32768) flush();
        else terminal.flush ??= setTimeout(flush, 16);
      }),
      pty.onExit(({ exitCode }) => {
        flush();
        this.emit(owner, { type: "terminal:exit", terminalId, projectId, sequence: ++terminal.sequence, exitCode });
        this.remove(terminalId, terminal, false);
      }),
    );
    return { terminalId, data: "", sequence: 0, exited: false };
  }

  input(owner: number, projectId: string, id: string, data: string) {
    this.find(owner, projectId, id).pty.write(data);
  }

  resize(owner: number, projectId: string, id: string, cols: number, rows: number) {
    this.find(owner, projectId, id).pty.resize(cols, rows);
  }

  close(owner: number, projectId: string, id: string) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    this.remove(id, this.find(owner, projectId, id), true);
  }

  closeOwner(owner: number) {
    for (const [id, terminal] of this.terminals) {
      if (terminal.owner === owner) this.remove(id, terminal, true);
    }
  }

  closeAll() {
    for (const [id, terminal] of this.terminals) this.remove(id, terminal, true);
  }

  private find(owner: number, projectId: string, id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.owner !== owner || terminal.projectId !== projectId) {
      throw new Error("This terminal is no longer open for this project.");
    }
    return terminal;
  }

  private remove(id: string, terminal: Terminal, kill: boolean) {
    this.terminals.delete(id);
    clearTimeout(terminal.flush);
    for (const subscription of terminal.subscriptions) subscription.dispose();
    if (kill) {
      try { terminal.pty.kill(); } catch { /* The shell may have just exited. */ }
    }
  }
}
