import assert from "node:assert/strict";
import { test } from "node:test";
import { projectArguments, QuitGuard, workspaceTitle } from "../src/main/native-workspace";

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
