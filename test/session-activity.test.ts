import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { SessionActivity } from "../src/shared/api.js";
import { fauxRuntime } from "./support/faux-runtime.js";

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
    runtime.trustProject(project.id);
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
      runtime.readSessionActivity(selection, result.taskId + 1);
      assert.equal(latest[0]?.state, "finished");
      runtime.readSessionActivity(selection, result.taskId);
      assert.deepEqual(latest, []);
      faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" })]);
      await runtime.send(input({ projectId: project.id, sessionId: second.id }, "This model call fails."));
      const failed = await attention.promise;
      assert.equal(failed.projectId, project.id);
      const plan = runtime.removalPlan({ projectId: project.id, sessionId: second.id });
      await runtime.remove({ projectId: project.id, sessionId: second.id }, plan.scope);
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
