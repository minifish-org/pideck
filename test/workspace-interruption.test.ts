import assert from "node:assert/strict";
import { test } from "node:test";
import { QuitGuard, workspaceInterruptionPrompt, type InterruptionAction } from "../src/main/workspace-interruption";

for (const action of ["quit", "update"] satisfies InterruptionAction[]) {
  test(`${action} stays silent only when both AI work and terminals are known idle`, () => {
    assert.equal(workspaceInterruptionPrompt(action, { active: false, terminalBusy: false }), undefined);
    for (const work of [
      { active: true, terminalBusy: false },
      { active: false, terminalBusy: true },
      { active: true, terminalBusy: true },
      { active: false },
      { active: true },
      undefined,
    ]) {
      const prompt = workspaceInterruptionPrompt(action, work);
      assert.ok(prompt);
      assert.equal(prompt.type, "warning");
      assert.equal(prompt.defaultId, 0, "Enter must keep work running, not authorize interruption.");
      assert.equal(prompt.cancelId, 0, "Dismissing the sheet must not authorize interruption.");
      assert.equal(prompt.noLink, true);
      assert.deepEqual(prompt.buttons, ["Keep Working", action === "quit" ? "Quit" : "Restart and Update"]);
      assert.match(prompt.detail!, /conversations, queued edits and drafts stay saved/);
    }
  });

  test(`${action} explains AI, terminal, combined and unavailable work without claiming that idle shells are busy`, () => {
    const ai = workspaceInterruptionPrompt(action, { active: true, terminalBusy: false })!;
    assert.match(ai.message, /AI work is running/);
    assert.match(ai.detail!, /AI work will be interrupted/);
    assert.doesNotMatch(ai.detail!, /Open terminals/);
    for (const work of [{ active: false, terminalBusy: true }, { active: false }]) {
      const terminal = workspaceInterruptionPrompt(action, work)!;
      assert.match(terminal.message, /terminal may be busy/);
      assert.match(terminal.detail!, /running commands or unfinished input/);
      assert.match(terminal.detail!, action === "quit" ? /Quitting closes them/ : /Restarting closes them/);
      assert.doesNotMatch(terminal.detail!, /Running AI work/);
    }
    const both = workspaceInterruptionPrompt(action, { active: true, terminalBusy: true })!;
    assert.match(both.detail!, /AI work will be interrupted/);
    assert.match(both.detail!, /running commands or unfinished input/);
    const unavailable = workspaceInterruptionPrompt(action)!;
    assert.match(unavailable.message, /workspace status is unavailable/);
    assert.match(unavailable.detail!, /could not check running AI work or terminals/);
  });
}

test("repeated quits share the status read and explicit choice; cancelling permits a fresh check", async () => {
  const status = Promise.withResolvers<{ active: boolean; terminalBusy: boolean }>();
  const choice = Promise.withResolvers<boolean>();
  let reads = 0;
  let asks = 0;
  const guard = new QuitGuard(async () => {
    reads++;
    const work = await status.promise;
    if (!workspaceInterruptionPrompt("quit", work)) return true;
    asks++;
    return choice.promise;
  });
  const first = guard.request();
  assert.equal(guard.request(), first);
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.equal(asks, 0);
  status.resolve({ active: false, terminalBusy: true });
  await Promise.resolve();
  assert.equal(guard.request(), first);
  assert.equal(asks, 1);
  choice.resolve(false);
  assert.equal(await first, false);
  assert.equal(await guard.request(), false);
  assert.equal(reads, 2);
  assert.equal(asks, 2);
});

test("a known-idle quit does not ask and a failed confirmation cannot authorize shutdown or block retry", async () => {
  let active = false;
  let fail = false;
  let asks = 0;
  const guard = new QuitGuard(async () => {
    if (!workspaceInterruptionPrompt("quit", { active, terminalBusy: false })) return true;
    asks++;
    if (fail) throw new Error("Native dialog unavailable.");
    return true;
  });
  assert.equal(await guard.request(), true);
  assert.equal(asks, 0);
  active = true;
  fail = true;
  await assert.rejects(guard.request(), /Native dialog unavailable/);
  fail = false;
  assert.equal(await guard.request(), true);
  assert.equal(asks, 2);
});
