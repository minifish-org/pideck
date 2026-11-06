import { strict as assert } from "node:assert";
import { setImmediate, setTimeout } from "node:timers/promises";
import { test } from "node:test";
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
  const { terminalId } = terminals.open(1, projectId, process.cwd(), 80, 24);
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

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (check()) return;
    await setTimeout(25);
  }
  throw new Error("Timed out waiting for PTY output.");
}
