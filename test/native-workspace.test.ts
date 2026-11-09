import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { closeWorkspaceProcess, projectArguments, QuitGuard, workspaceTitle } from "../src/main/native-workspace";
import type { ToHost } from "../src/shared/transport";

test("OS project arguments preserve paths without interpreting profile flags or commands", () => {
  assert.deepEqual(projectArguments(["--user-data-dir", "/tmp/profile", "--remote-debugging-port=9222", "a folder", "/tmp/code", "/tmp/code"], "/tmp"),
    ["/tmp/a folder", "/tmp/code"]);
  assert.deepEqual(projectArguments(["--", "-a folder", "$(touch file)", "bad\0path"], "/tmp"),
    ["/tmp/-a folder", "/tmp/$(touch file)"]);
  assert.equal(workspaceTitle({ name: "project" }, { title: "Review\n\u202e files" }), "Review files — project — Pideck");
  assert.equal(workspaceTitle(), "Pideck");
});

test("idle quit stays silent and repeated active quits share one explicit choice", async () => {
  let active = false;
  let asks = 0;
  let finish!: (value: boolean) => void;
  const guard = new QuitGuard(async () => active, () => {
    asks++;
    return new Promise(resolve => { finish = resolve; });
  });
  assert.equal(await guard.request(), true);
  assert.equal(asks, 0);
  active = true;
  const first = guard.request();
  assert.equal(guard.request(), first);
  await Promise.resolve();
  assert.equal(asks, 1);
  finish(false);
  assert.equal(await first, false);
  const next = guard.request();
  await Promise.resolve();
  assert.equal(asks, 2);
  finish(true);
  assert.equal(await next, true);
});

class WorkspaceProcess extends EventEmitter {
  sent: ToHost[] = [];
  kills = 0;
  failPost = false;
  postMessage(message: ToHost) {
    if (this.failPost) throw new Error("The workspace channel is closed.");
    this.sent.push(message);
  }
  kill() { this.kills++; return true; }
}

test("workspace close requires a cleanup receipt and actual exit before reporting graceful", async () => {
  const child = new WorkspaceProcess();
  let resolved = false;
  const closing = closeWorkspaceProcess(child).then(result => { resolved = true; return result; });
  assert.deepEqual(child.sent, [{ type: "shutdown" }]);
  child.emit("message", { type: "shutdown:complete" });
  assert.deepEqual(child.sent, [{ type: "shutdown" }, { type: "shutdown:exit" }]);
  await Promise.resolve();
  assert.equal(resolved, false, "A cleanup receipt is not proof that the store-owning process exited.");
  child.emit("exit", 0);
  assert.deepEqual(await closing, { status: "graceful" });
  assert.equal(child.kills, 0);
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("exit"), 0);
});

test("cleanup errors, crashes, and an unacknowledged exit cannot authorize installation", async () => {
  for (const [receipt, code, expected] of [
    [{ type: "shutdown:complete", error: "Queue edit metadata did not flush." }, 1,
      { status: "failed", reason: "cleanup-failed", message: "Queue edit metadata did not flush." }],
    [undefined, 0, { status: "failed", reason: "unexpected-exit", message: "The workspace exited without a clean shutdown (exit 0)." }],
    [{ type: "shutdown:complete" }, 1,
      { status: "failed", reason: "unexpected-exit", message: "The workspace exited without a clean shutdown (exit 1)." }],
  ] as const) {
    const child = new WorkspaceProcess();
    const closing = closeWorkspaceProcess(child);
    if (receipt) child.emit("message", receipt);
    child.emit("exit", code);
    assert.deepEqual(await closing, expected);
  }
});

test("a close timeout reports forced termination only after observing exit, with a bounded no-exit fallback", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new WorkspaceProcess();
  let resolved = false;
  const closing = closeWorkspaceProcess(child).then(result => { resolved = true; return result; });
  t.mock.timers.tick(7_999);
  assert.equal(child.kills, 0);
  t.mock.timers.tick(1);
  assert.equal(child.kills, 1);
  await Promise.resolve();
  assert.equal(resolved, false);
  child.emit("exit", -1);
  assert.deepEqual(await closing, { status: "forced", reason: "timeout", exited: true });

  const stuck = new WorkspaceProcess();
  const stopped = closeWorkspaceProcess(stuck);
  t.mock.timers.tick(8_000);
  t.mock.timers.tick(2_000);
  assert.deepEqual(await stopped, { status: "forced", reason: "timeout", exited: false });
  assert.equal(stuck.listenerCount("exit"), 0);
});

test("a shutdown channel failure force-stops the worker and never reports a graceful close", async () => {
  const child = new WorkspaceProcess();
  child.failPost = true;
  const closing = closeWorkspaceProcess(child);
  assert.equal(child.kills, 1);
  child.emit("exit", -1);
  assert.deepEqual(await closing, { status: "forced", reason: "request-failed", exited: true });
});
