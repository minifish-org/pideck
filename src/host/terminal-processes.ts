import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

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
