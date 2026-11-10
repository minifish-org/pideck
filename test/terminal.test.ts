import { strict as assert } from "node:assert";
import { setImmediate, setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminals } from "../src/host/terminal";
import { connectTerminal, type TerminalStatus } from "../src/renderer/terminal-connection";
import type { Commands, HostEvent, Pideck, TerminalEvent } from "../src/shared/api";

const projectId = "test-project";
const terminalId = "test-terminal";
const frame = (sequence: number, data: string): TerminalEvent => ({
  type: "terminal:data", projectId, terminalId, sequence, data,
});

test("terminal input and resize stay ordered while opening and output gaps replay before acknowledgement", async () => {
  const opening = Promise.withResolvers<Commands["terminal:open"][1]>();
  const firstInput = Promise.withResolvers<void>();
  const calls: unknown[][] = [];
  const writes: { data: string; consumed: () => void }[] = [];
  const statuses: TerminalStatus[] = [];
  let listener: ((event: HostEvent) => void) | undefined;
  const invoke = (command: string, payload: Record<string, unknown>) => {
    calls.push([command, payload]);
    if (command === "terminal:open") return opening.promise;
    if (command === "terminal:input" && payload.data === "first") return firstInput.promise;
    if (command === "terminal:sync") return Promise.resolve(payload.replay ? [frame(1, "one"), frame(2, "two")] : []);
    return Promise.resolve();
  };
  const bridge: Pideck = {
    platform: process.platform,
    invoke: invoke as Pideck["invoke"],
    onEvent: receive => { listener = receive; return () => { listener = undefined; }; },
  };
  const connection = connectTerminal({
    bridge, projectId, initialSize: { cols: 80, rows: 24 },
    write: (data, consumed) => writes.push({ data, consumed }),
    status: status => statuses.push(status),
    issue: () => {},
  });

  connection.input("first");
  connection.input("second");
  connection.resize({ cols: 81, rows: 25 });
  connection.resize({ cols: 90, rows: 27 });
  listener?.(frame(2, "two"));
  opening.resolve({ terminalId, data: "", sequence: 0, exited: false });
  await setImmediate();
  assert.equal(statuses.at(-1)?.type, "running");
  assert.deepEqual(writes.map(write => write.data), ["one", "two"]);
  assert.deepEqual(calls.filter(([name]) => name === "terminal:sync"), [
    ["terminal:sync", { projectId, terminalId, through: 0, replay: true }],
  ]);
  assert.deepEqual(calls.filter(([name]) => name === "terminal:input" || name === "terminal:resize"), [
    ["terminal:resize", { projectId, terminalId, cols: 90, rows: 27 }],
    ["terminal:input", { projectId, terminalId, data: "first" }],
  ]);
  firstInput.resolve();
  listener?.(frame(2, "duplicate"));
  writes[0].consumed();
  writes[1].consumed();
  await setImmediate();
  assert.deepEqual(writes.map(write => write.data), ["one", "two"]);
  assert.deepEqual(calls.filter(([name]) => name === "terminal:input").at(-1),
    ["terminal:input", { projectId, terminalId, data: "second" }]);
  assert.deepEqual(calls.filter(([name]) => name === "terminal:sync").at(-1),
    ["terminal:sync", { projectId, terminalId, through: 2 }]);
  connection.stop();
  assert.equal(listener, undefined);
  assert.deepEqual(calls.at(-1), ["terminal:close", { projectId, terminalId }]);
});

test("native PTY pauses unread output, replays in sequence, and resumes after acknowledgement", {
  skip: process.platform === "win32", timeout: 10_000,
}, async t => {
  const frames: TerminalEvent[] = [];
  const terminals = new Terminals((_owner, event) => {
    if (event.type === "terminal:data" || event.type === "terminal:exit") frames.push(event);
  });
  t.after(() => terminals.closeAll());
  const { terminalId } = await openTestTerminal(terminals, 1, projectId);
  terminals.input(1, projectId, terminalId, "yes pideck-flow | head -n 50000; printf '\\nPTY_%s\\n' done\r");
  await waitFor(() => frames.filter(event => event.type === "terminal:data").reduce((sum, event) => sum + event.data.length, 0) > 110_000);
  await setTimeout(100);
  const firstWindow = terminals.sync(1, projectId, terminalId, 0, true);
  assert.ok(firstWindow.length > 0);
  assert.ok(firstWindow.reduce((sum, event) => sum + (event.type === "terminal:data" ? event.data.length : 0), 0) < 220_000);
  assert.deepEqual(firstWindow.map(event => event.sequence), firstWindow.map((_event, index) => index + 1));
  assert.throws(() => terminals.sync(2, projectId, terminalId, 0, true), /no longer open/);
  let through = firstWindow.at(-1)!.sequence;
  let tail = "";
  await waitFor(() => {
    const unread = terminals.sync(1, projectId, terminalId, through, true);
    if (unread.length) through = unread.at(-1)!.sequence;
    const data = unread.flatMap(event => event.type === "terminal:data" ? [event.data] : []).join("");
    const combined = tail + data;
    tail = combined.slice(-32);
    return combined.includes("PTY_done");
  });
  terminals.close(1, projectId, terminalId);
  assert.throws(() => terminals.input(1, projectId, terminalId, "x"), /no longer open/);
});

test("detaching a screen drops unsubmitted input without stopping its shell, including an in-flight open", async () => {
  const opening = Promise.withResolvers<Commands["terminal:open"][1]>();
  const calls: string[] = [];
  let listener: ((event: HostEvent) => void) | undefined;
  const bridge: Pideck = {
    platform: process.platform,
    invoke: ((command: string) => {
      calls.push(command);
      return command === "terminal:open" ? opening.promise : Promise.resolve();
    }) as Pideck["invoke"],
    onEvent: receive => { listener = receive; return () => { listener = undefined; }; },
  };
  const connection = connectTerminal({ bridge, projectId, initialSize: { cols: 80, rows: 24 },
    write: (_data, consumed) => consumed(), status: () => {}, issue: () => {} });
  connection.input("do not replay me\r");
  connection.stop(false);
  opening.resolve({ terminalId, data: "", sequence: 0, exited: false });
  await setImmediate();
  assert.equal(listener, undefined);
  assert.deepEqual(calls, ["terminal:open"]);
});

test("closing a window keeps its shell and drains bounded output until another owner reattaches", {
  skip: process.platform === "win32", timeout: 10_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-terminal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const done = join(directory, "done");
  const frames: { owner: number; event: TerminalEvent }[] = [];
  const terminals = new Terminals((owner, event) => {
    if (event.type === "terminal:data" || event.type === "terminal:exit") frames.push({ owner, event });
  });
  t.after(() => terminals.closeAll());
  assert.equal(terminals.liveCount(), 0);
  const opened = await openTestTerminal(terminals, 1, projectId);
  assert.equal(terminals.liveCount(), 1);
  terminals.input(1, projectId, opened.terminalId, "PIDECK_SESSION=retained; printf '\\nBEFORE_%s:%s\\n' detach $$\r");
  const output = () => frames.flatMap(({ event }) => event.type === "terminal:data" ? [event.data] : []).join("");
  await waitFor(() => /\nBEFORE_detach:(\d+)\r?\n/.test(output()));
  const pid = output().match(/\nBEFORE_detach:(\d+)\r?\n/)![1];
  terminals.sync(1, projectId, opened.terminalId, frames.at(-1)!.event.sequence);
  const snapshot = await openTestTerminal(terminals, 1, projectId);
  assert.equal(snapshot.terminalId, opened.terminalId);
  assert.match(snapshot.data, /BEFORE_detach:/, "acknowledged screen history remains available to a new renderer");
  terminals.input(1, projectId, opened.terminalId,
    `yes retained | head -n 180000; printf '\\nDETACHED_%s\\n' DONE; : > '${done.replaceAll("'", "'\\''")}'\r`);
  terminals.closeOwner(1);
  assert.equal(terminals.liveCount(), 1, "A detached idle shell remains live without proving a foreground job is busy.");
  const eventCount = frames.length;
  assert.throws(() => terminals.input(1, projectId, opened.terminalId, "x"), /no longer open/);
  assert.throws(() => terminals.resize(1, projectId, opened.terminalId, 80, 24), /no longer open/);
  await waitForAsync(async () => { try { await stat(done); return true; } catch { return false; } });
  assert.equal(frames.length, eventCount, "a closed owner receives no more output");
  const attached = await openTestTerminal(terminals, 2, projectId);
  assert.equal(attached.terminalId, opened.terminalId);
  assert.equal(attached.exited, false);
  assert.equal(terminals.liveCount(), 1);
  assert.ok(attached.data.length <= 1024 * 1024 + 64);
  assert.match(attached.data, /Earlier terminal output omitted/);
  assert.match(attached.data, /DETACHED_DONE/);
  terminals.input(2, projectId, attached.terminalId, "printf '\\nAFTER_%s:%s:%s\\n' attach $$ \"$PIDECK_SESSION\"\r");
  await waitFor(() => output().includes(`AFTER_attach:${pid}:retained`));
  assert.throws(() => terminals.sync(1, projectId, attached.terminalId, 0, true), /no longer open/);
  terminals.close(2, projectId, attached.terminalId);
  const replacement = await openTestTerminal(terminals, 2, projectId);
  assert.notEqual(replacement.terminalId, attached.terminalId, "explicit restart creates a new shell");
});

test("closing a project kills its shells across owners and keeps other projects alive", {
  skip: process.platform === "win32", timeout: 10_000,
}, async t => {
  const output = new Map<string, string>();
  const terminals = new Terminals((_owner, event) => {
    if (event.type === "terminal:data") output.set(event.terminalId, (output.get(event.terminalId) ?? "") + event.data);
  });
  t.after(() => terminals.closeAll());
  const removed = await Promise.all([1, 2].map(async owner => ({ owner, ...await openTestTerminal(terminals, owner, projectId) })));
  const retained = await openTestTerminal(terminals, 1, "other-project");
  // A shell may paint its prompt before or after input is echoed. Start output
  // markers on their own line so readiness does not depend on that timing.
  for (const { owner, terminalId } of removed) terminals.input(owner, projectId, terminalId, "printf '\\nSHELL_PID:%s\\n' $$\r");
  const readPid = (id: string) => Number(output.get(id)?.match(/\nSHELL_PID:(\d+)\r?\n/)?.[1]);
  await waitFor(() => removed.every(({ terminalId }) => readPid(terminalId) > 0));
  const first = removed[0];
  const job = process.platform === "linux"
    ? `sh -c 'trap "" HUP; printf "\\nJOB_READY:%s\\n" $$; exec sleep 15'`
    : "sleep 15";
  terminals.input(first.owner, projectId, first.terminalId, `${job} & printf '\\nJOB_PID:%s\\n' $!\r`);
  const readJob = () => Number(output.get(first.terminalId)?.match(/\nJOB_PID:(\d+)\r?\n/)?.[1]);
  let jobStopped = false;
  t.after(() => {
    const job = readJob();
    if (job && !jobStopped) try { process.kill(job, "SIGKILL"); } catch { /* The shell already cleaned up the job. */ }
  });
  const second = removed[1];
  terminals.input(second.owner, projectId, second.terminalId, "trap '' HUP; printf 'HUP_%s\\n' READY\r");
  await waitFor(() => readJob() > 0 && Boolean(output.get(second.terminalId)?.includes("HUP_READY"))
    && (process.platform !== "linux" || /\nJOB_READY:\d+\r?\n/.test(output.get(first.terminalId) ?? "")));

  // Removal also waits for a terminal whose ordinary close already began.
  terminals.close(second.owner, projectId, second.terminalId);
  const closing = terminals.closeProject(projectId);
  for (const { owner, terminalId } of removed) {
    assert.throws(() => terminals.input(owner, projectId, terminalId, "x"), /no longer open/);
    assert.throws(() => terminals.sync(owner, projectId, terminalId, 0, true), /no longer open/);
  }
  await closing;
  for (const pid of [...removed.map(({ terminalId }) => readPid(terminalId)), readJob()]) {
    await waitFor(() => !isRunning(pid));
  }
  jobStopped = true;
  terminals.input(1, "other-project", retained.terminalId, "printf 'STILL_%s\\n' RUNNING\r");
  await waitFor(() => Boolean(output.get(retained.terminalId)?.includes("STILL_RUNNING")));
});

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const status = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = status.slice(status.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
      // A dead orphan can remain visible until the runner's init reaps it.
      // Sleeping/runnable/stopped processes must still disappear after cleanup.
      if (state === "Z" || state === "X") return false;
    }
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

function openTestTerminal(terminals: Terminals, owner: number, projectId: string) {
  const previous = process.env.SHELL;
  // Lifecycle tests expect plain POSIX output independently of local startup files.
  process.env.SHELL = "/bin/sh";
  try {
    return terminals.open(owner, projectId, process.cwd(), 80, 24);
  } finally {
    if (previous === undefined) delete process.env.SHELL;
    else process.env.SHELL = previous;
  }
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (check()) return;
    await setTimeout(25);
  }
  throw new Error("Timed out waiting for PTY output.");
}

async function waitForAsync(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (await check()) return;
    await setTimeout(25);
  }
  throw new Error("Timed out waiting for detached shell completion.");
}


test('a reclaimed terminal discards stream gaps silently, reports visibility, and never replays input', async () => {
  const calls: { command: string; payload: unknown }[] = [];
  const statuses: TerminalStatus[] = [];
  let listener: ((event: HostEvent) => void) | undefined;
  const bridge: Pideck = {
    platform: process.platform,
    invoke: ((command: string, payload: unknown) => {
      calls.push({ command, payload });
      return Promise.resolve(command === 'terminal:open' ? { terminalId, data: '', sequence: 0, exited: false } : []);
    }) as Pideck['invoke'],
    onEvent: receive => { listener = receive; return () => { listener = undefined; }; },
  };
  const connection = connectTerminal({ bridge, projectId, initialSize: { cols: 80, rows: 24 },
    visible: false, write: () => assert.fail('recycling must not append a notice'), status: value => statuses.push(value), issue: () => {} });
  await setImmediate();
  assert.deepEqual(calls.find(call => call.command === 'terminal:visibility')?.payload, { projectId, terminalId, visible: false });
  connection.visibility(true);
  assert.deepEqual(calls.at(-1)?.payload, { projectId, terminalId, visible: true });
  listener?.({ type: 'terminal:reclaimed', projectId, terminalId, sequence: 3 });
  assert.deepEqual(statuses.at(-1), { type: 'reclaimed', message: '' });
  assert.equal(calls.filter(call => call.command === 'terminal:sync').length, 0);
  connection.input('never replay this\r');
  assert.equal(calls.filter(call => call.command === 'terminal:input').length, 0);
  assert.equal(listener, undefined);
});
