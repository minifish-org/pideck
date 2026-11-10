import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { SessionActivity } from "../src/shared/api.js";
import { fauxRuntime, waitForView } from "./support/faux-runtime.js";

test("Durable reports background session completion and failure without opening a transcript", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-activity-"));
  const projectDir = join(root, "project");
  await mkdir(projectDir);
  const { open, input, faux } = fauxRuntime(join(root, "app"));
  const runtime = await open();
  const release = Promise.withResolvers<void>();
  const running = Promise.withResolvers<SessionActivity>();
  const finished = Promise.withResolvers<SessionActivity>();
  const attention = Promise.withResolvers<SessionActivity>();
  try {
    const project = runtime.addProject(projectDir);
    const first = await runtime.createSession(project.id, "Work in another session");
    const second = await runtime.createSession(project.id, "Model failure");
    const selection = { projectId: project.id, sessionId: first.id };
    let latest: SessionActivity[] = [];
    const detach = runtime.watchSessionActivity(items => {
      latest = items;
      for (const item of items) {
        if (item.sessionId === first.id && item.state === "running") running.resolve(item);
        if (item.sessionId === first.id && item.state === "finished") finished.resolve(item);
        if (item.sessionId === second.id && item.state === "attention" && item.settled) attention.resolve(item);
      }
    });
    try {
      faux.setResponses([async () => {
        await release.promise;
        return fauxAssistantMessage("Done.");
      }]);
      await runtime.send(input(selection, "Run in the background."));
      const active = await running.promise;
      assert.equal(active.settled, false);
      assert.equal(active.projectId, project.id);
      runtime.readSessionActivity(selection, active.taskId);
      assert.equal(latest[0]?.state, "running");
      release.resolve();
      const result = await finished.promise;
      assert.equal(result.taskId, active.taskId);
      const done = await waitForView(runtime, selection, view => view.status === "idle" && view.messages.length >= 2);
      assert.ok(result.resultEntryId);
      assert.equal(result.resultEntryId, done.messages.at(-1)?.entryId);
      assert.equal(done.latestEntryId, result.resultEntryId);
      runtime.readSessionActivity(selection, result.taskId + 1);
      assert.equal(latest[0]?.state, "finished");
      runtime.readSessionActivity(selection, result.taskId);
      assert.deepEqual(latest, []);
      faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" })]);
      await runtime.send(input({ projectId: project.id, sessionId: second.id }, "This model call fails."));
      const failed = await attention.promise;
      assert.equal(failed.projectId, project.id);
      const failedSelection = { projectId: project.id, sessionId: second.id };
      const failedView = await waitForView(runtime, failedSelection, view => view.status === "idle" && Boolean(view.error));
      assert.equal(failedView.failureTaskId, failed.taskId);
      const plan = runtime.removalPlan(failedSelection);
      await runtime.remove(failedSelection, plan.scope);
      assert.deepEqual(latest, []);
    } finally {
      detach();
    }
  } finally {
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unread results survive relaunch, while reads and removals stay cleared", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-unread-"));
  const directory = join(root, "project");
  const data = join(root, "app");
  await mkdir(directory);
  const fixture = fauxRuntime(data);
  let runtime = await fixture.open();
  try {
    const project = runtime.addProject(directory);
    const first = await runtime.createSession(project.id, "Unread success");
    const second = await runtime.createSession(project.id, "Unread failure");
    const success = { projectId: project.id, sessionId: first.id };
    const failure = { projectId: project.id, sessionId: second.id };
    const completed = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<void>();
    const detach = runtime.watchSessionActivity(items => {
      if (items.some(item => item.sessionId === first.id && item.settled)) completed.resolve();
      if (items.some(item => item.sessionId === second.id && item.settled)) failed.resolve();
    });
    fixture.faux.setResponses([fauxAssistantMessage("Done.")]);
    await runtime.send(fixture.input(success, "Complete out of view."));
    await completed.promise;
    fixture.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" })]);
    await runtime.send(fixture.input(failure, "Fail out of view."));
    await failed.promise;
    detach();
    const unread = runtime.sessionActivities();
    assert.equal(unread.length, 2);
    assert.equal(runtime.hasActiveWork(), false);
    await runtime.close();

    runtime = await fixture.open();
    assert.deepEqual(runtime.sessionActivities(), unread);
    const result = unread.find(item => item.sessionId === first.id)!;
    runtime.readSessionActivity(success, result.taskId - 1);
    assert.deepEqual(runtime.sessionActivities(), unread);
    runtime.readSessionActivity(success, result.taskId);
    const plan = runtime.removalPlan(failure);
    await runtime.remove(failure, plan.scope);
    assert.deepEqual(runtime.sessionActivities(), []);
    await runtime.close();

    // The metadata foreign key must clear activity in the same deletion,
    // rather than leaving receipts to be cleaned up on the next launch.
    const database = new DatabaseSync(join(data, "workspace.sqlite"), { readOnly: true });
    try { assert.deepEqual(database.prepare("SELECT * FROM session_activity").all(), []); }
    finally { database.close(); }
    runtime = await fixture.open();
    assert.deepEqual(runtime.sessionActivities(), []);
    assert.deepEqual((await runtime.listSessions(project.id)).map(session => session.id), [first.id]);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a host restart resumes tracked work and reconciles a missed completion receipt", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-unread-recover-"));
  const directory = join(root, "project");
  const data = join(root, "app");
  await mkdir(directory);
  const fixture = fauxRuntime(data);
  let runtime = await fixture.open();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  try {
    const project = runtime.addProject(directory);
    const session = await runtime.createSession(project.id);
    const selection = { projectId: project.id, sessionId: session.id };
    fixture.faux.setResponses([async () => {
      started.resolve();
      await release.promise;
      return fauxAssistantMessage("Before restart.");
    }]);
    await runtime.send(fixture.input(selection, "Continue through a host restart."));
    await started.promise;
    assert.equal(runtime.hasActiveWork(), true);
    const oldTask = runtime.sessionActivities()[0]?.taskId;
    assert.ok(oldTask);
    const closing = runtime.close();
    release.resolve();
    await closing;

    fixture.faux.setResponses([fauxAssistantMessage("Recovered.")]);
    runtime = await fixture.open();
    const finished = Promise.withResolvers<SessionActivity>();
    const detach = runtime.watchSessionActivity(items => {
      const item = items.find(item => item.sessionId === session.id && item.settled);
      if (item) finished.resolve(item);
    });
    const result = await finished.promise;
    detach();
    assert.equal(result.taskId, oldTask);
    assert.equal(result.state, "finished");
    await runtime.close();

    // Simulate the small cross-store crash gap after Durable commits the
    // terminal receipt but before app metadata commits its settled state.
    const database = new DatabaseSync(join(data, "workspace.sqlite"));
    try { database.prepare("UPDATE session_activity SET settled = 0, state = 'running', resultEntryId = NULL").run(); }
    finally { database.close(); }
    runtime = await fixture.open();
    assert.deepEqual(runtime.sessionActivities(), [result]);
    assert.equal(runtime.hasActiveWork(), false);
  } finally {
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a running follow-up queue produces one settled result after the final generation", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-activity-queue-"));
  const directory = join(root, "project");
  await mkdir(directory);
  const fixture = fauxRuntime(join(root, "app"));
  const runtime = await fixture.open();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  try {
    const project = runtime.addProject(directory);
    const session = await runtime.createSession(project.id);
    const selection = { projectId: project.id, sessionId: session.id };
    fixture.faux.setResponses([
      async () => { started.resolve(); await release.promise; return fauxAssistantMessage("First answer."); },
      fauxAssistantMessage("Final answer."),
    ]);
    const finished = Promise.withResolvers<SessionActivity>();
    const settled: SessionActivity[] = [];
    const detach = runtime.watchSessionActivity(items => {
      const item = items.find(item => item.sessionId === session.id && item.settled);
      if (item) { settled.push(item); finished.resolve(item); }
    });
    await runtime.send(fixture.input(selection, "First input."));
    await started.promise;
    await runtime.send({ ...fixture.input(selection, "Queued follow-up."), delivery: "follow-up" });
    release.resolve();
    const result = await finished.promise;
    detach();
    const view = await waitForView(runtime, selection, view => view.status === "idle" && view.messages.length === 4);
    assert.equal(settled.length, 1);
    assert.equal(result.resultEntryId, view.messages.at(-1)?.entryId);
  } finally {
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
