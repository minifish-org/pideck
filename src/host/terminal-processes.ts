import { readFile, readdir } from "node:fs/promises";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from "node:path";

const exec = promisify(execFile);

export function idleTerminalSnapshot(output: string, pid: number): boolean {
  const processes = output.trim().split('\n').map(line => line.trim().split(/\s+/));
  if (processes.some(fields => fields.length !== 6 || fields.slice(0, 4).some(value => !/^-?\d+$/.test(value)))) return false;
  const byPid = new Map(processes.map(fields => [Number(fields[0]), fields]));
  const shell = byPid.get(pid);
  // pid, ppid, pgid, foreground pgid, tty, state. The shell must own its
  // foreground group; any other live process on the PTY keeps it alive.
  if (!shell || shell.length !== 6 || Number(shell[2]) !== pid || Number(shell[3]) !== pid
    || !shell[4] || ['?', '??', '-'].includes(shell[4]) || !/^S/.test(shell[5])) return false;
  return !processes.some(fields => {
    if (Number(fields[0]) === pid || /^[ZX]/.test(fields[5])) return false;
    if (fields[4] === shell[4]) return true;
    // A background child may deliberately detach from the TTY (setsid/nohup).
    const seen = new Set<number>();
    let parent = Number(fields[1]);
    while (parent > 1 && !seen.has(parent)) {
      if (parent === pid) return true;
      seen.add(parent);
      parent = Number(byPid.get(parent)?.[1] ?? 0);
    }
    return false;
  });
}

export async function terminalHasNoJobs(pid: number): Promise<boolean> {
  if (process.platform === 'win32') return false;
  try {
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,tty=,stat='],
      { timeout: 1500, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    return idleTerminalSnapshot(stdout, pid);
  } catch { return false; }
}
export type TerminalSession = { id: number; startTime: string };
type Process = { pid: number; group: number; session: number; startTime: string; state: string };

async function readProcess(pid: number, directory: string): Promise<Process | undefined> {
  let stat: string;
  try { stat = await readFile(join(directory, String(pid), "stat"), "utf8"); }
  catch (error) {
    if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  // comm can contain spaces and parentheses. Fields after its final ')' begin
  // with state (3), ppid (4), pgrp (5), session (6), ... starttime (22).
  const end = stat.lastIndexOf(")");
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  if (end < 0 || Number(stat.slice(0, stat.indexOf(" "))) !== pid || fields.length < 20
    || !/^\d+$/.test(fields[19]!)) return;
  const group = Number(fields[2]);
  const session = Number(fields[3]);
  if (!Number.isSafeInteger(group) || group <= 1 || !Number.isSafeInteger(session) || session <= 1) return;
  return { pid, group, session, startTime: fields[19]!, state: fields[0]! };
}

// forkpty gives the shell its own session. Never infer ownership from command
// names, working directories, or merely being another process of the same user.
export async function captureTerminalSession(pid: number, directory = "/proc"): Promise<TerminalSession | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  const leader = await readProcess(pid, directory);
  if (leader?.session === pid && leader.group === pid) return { id: pid, startTime: leader.startTime };
}

export async function terminalSessionGroups(session: TerminalSession, directory = "/proc"): Promise<number[]> {
  const matches = (leader: Process | undefined) => !leader || (leader.session === session.id
    && leader.group === session.id && leader.startTime === session.startTime);
  if (!matches(await readProcess(session.id, directory))) return [];
  const entries = (await readdir(directory)).filter(entry => /^[1-9]\d*$/.test(entry));
  const groups = new Set<number>();
  for (let offset = 0; offset < entries.length; offset += 32) {
    const processes = await Promise.all(entries.slice(offset, offset + 32).map(entry => readProcess(Number(entry), directory)));
    for (const process of processes) {
      if (process?.session === session.id && process.state !== "Z" && process.state !== "X") groups.add(process.group);
    }
  }
  // Check again after enumeration, including on the force-kill pass. An exited
  // shell's numeric PID must never authorize killing a later unrelated session.
  if (!matches(await readProcess(session.id, directory))) return [];
  // Stop jobs before the shell so it has a chance to reap them.
  return [...groups].sort((a, b) => a === session.id ? 1 : b === session.id ? -1 : a - b);
}
