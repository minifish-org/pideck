import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTask, GenerationTask, Harness, hook, LiveDoc, runEndTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ChatView, Selection, StartChat } from "../src/shared/api.js";
import { Runtime } from "../src/host/runtime.js";
import { continueEntryKind, inputEntryKind } from "../src/host/chat-view.js";
import { activeRunStartedAt, completedRun } from "../src/host/run-timing.js";
import { fauxRuntime, toolResponse, waitForView } from "./support/faux-runtime.js";

async function openFixture() {
  const root = await mkdtemp(join(tmpdir(), "pideck-runtime-"));
  const projectDir = join(root, "project");
  await mkdir(projectDir);
  const data = join(root, "app");
  const { faux, open, input } = fauxRuntime(data);
  const runtime = await open();
  const project = runtime.addProject(projectDir);
  const session = await runtime.createSession(project.id);
  const selection: Selection = { projectId: project.id, sessionId: session.id };
  return { root, data, projectDir, faux, runtime, project, session, selection, input: input(selection, "Check this project."), open };
}

test("opening a folder registers it immediately and a replacement must be reopened", async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-project-open-"));
  const folder = join(root, "project");
  const { open } = fauxRuntime(join(root, "app"));
  const runtime = await open();
  try {
    assert.throws(() => runtime.addProject(folder), /directory is unavailable/);
    assert.deepEqual(runtime.listProjects(), []);
    assert.throws(() => runtime.requireProject(randomUUID()), /Project not found/);

    await mkdir(folder);
    const project = runtime.addProject(folder);
    assert.deepEqual(runtime.requireProject(project.id), project);
    assert.deepEqual(runtime.addProject(folder), project);

    await rename(folder, join(root, "original"));
    await mkdir(folder);
    assert.throws(() => runtime.requireProject(project.id), /folder changed/);
    assert.deepEqual(runtime.addProject(folder), project);
    assert.deepEqual(runtime.requireProject(project.id), project);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("project ownership, built-in coding tools, watch reattachment, and durable reopen", async () => {
  const fixture = await openFixture();
  const { root, data, projectDir, project, session, selection, input, faux } = fixture;
  let runtime = fixture.runtime;
  const secretVariable = "PIDECK_TEST_PROVIDER_SECRET";
  process.env[secretVariable] = "not-for-the-shell";
  try {
    const otherProject = runtime.addProject(root);
    await assert.rejects(runtime.watch({ ...selection, projectId: otherProject.id }, () => {}), /Session not found/);
    const projectModels = await runtime.listModels();
    assert.ok(projectModels.some(model => model.configured && model.id === input.model.id));

    await writeFile(join(projectDir, "hello.txt"), "before\n");
    await writeFile(join(projectDir, "AGENTS.md"), "Project rule for the fixture: inspect hello.txt before changing it.\n");
    let readProjectInstructions = false;
    faux.setResponses([
      request => {
        readProjectInstructions = request.messages.some(message => message.role === "system"
          && getSystemMessageText(message).includes("Project rule for the fixture"));
        return toolResponse("edit", { path: "hello.txt", edits: [{ oldText: "before", newText: "after" }] });
      },
      toolResponse("write", { path: "hello.txt", content: "rewritten\n" }),
      toolResponse("write", { path: "new file.txt", content: "created\n" }),
      toolResponse("bash", {
        command: `! printenv ${secretVariable} && cat hello.txt`,
      }),
      fauxAssistantMessage("Verified."),
    ]);
    const finished = waitForView(runtime, selection, view => view.messages.some(
      message => message.blocks.some(block => block.type === "text" && block.text === "Verified."),
    ));
    await runtime.send(input);
    const view = await finished;
    assert.equal(readProjectInstructions, true);
    const blocks = view.messages.flatMap(message => message.blocks);
    assert.ok(blocks.some(block => block.type === "tool" && block.name === "edit" && block.patch?.includes("+after")));
    assert.ok(blocks.some(block => block.type === "tool" && block.name === "write"
      && block.patch?.includes("-after\n+rewritten")));
    assert.ok(blocks.some(block => block.type === "tool" && block.name === "write"
      && block.patch?.includes("--- /dev/null") && block.patch.includes("+created")));
    assert.ok(blocks.some(block => block.type === "tool" && block.name === "bash" && block.output?.trim() === "rewritten"));
    assert.equal(await readFile(join(projectDir, "hello.txt"), "utf8"), "rewritten\n");
    const deviceId = runtime.deviceId();
    await runtime.close();

    // A project persisted by an older build can have its trust flag unset.
    {
      using database = new DatabaseSync(join(data, "workspace.sqlite"));
      database.prepare("UPDATE projects SET trusted = 0 WHERE id = ?").run(project.id);
    }
    runtime = await fixture.open();
    assert.equal(runtime.deviceId(), deviceId);
    assert.equal(runtime.listSessions(project.id)[0].id, session.id);
    const reopened = await waitForView(runtime, selection, () => true);
    assert.deepEqual(reopened.messages, view.messages);
    assert.deepEqual(reopened.model, input.model);

    faux.setResponses([
      toolResponse("bash", { command: "printf legacy-ok > ../legacy-marker.txt" }),
      fauxAssistantMessage("Legacy project verified."),
    ]);
    const legacyFinished = waitForView(runtime, selection, view => view.messages.some(message =>
      message.blocks.some(block => block.type === "text" && block.text === "Legacy project verified."),
    ));
    await runtime.send({ ...input, text: "Check the reopened project." });
    await legacyFinished;
    assert.equal(await readFile(join(root, "legacy-marker.txt"), "utf8"), "legacy-ok");

    await rename(projectDir, join(root, "old-project"));
    await mkdir(projectDir);
    await assert.rejects(runtime.send(input), /folder changed/);
    assert.deepEqual(runtime.addProject(projectDir), project);
    assert.equal(runtime.listSessions(project.id)[0].id, session.id);
  } finally {
    delete process.env[secretVariable];
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native provider catalog and host credentials determine model availability", async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-credentials-"));
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "ambient-test-key";
  const runtime = await Runtime.open(root);
  try {
    const hasOpenAI = async () => (await runtime.listModels()).some(model => model.provider === "openai" && model.configured);
    const models = await runtime.listModels();
    assert.ok(runtime.models.getProviders().length > 20);
    assert.ok(models.some(model => model.provider === "google" && model.contextWindow));
    assert.equal(await hasOpenAI(), true);
    delete process.env.OPENAI_API_KEY;
    assert.equal(await hasOpenAI(), false);
    await runtime.models.login("openai", "api_key", {
      prompt: async () => "saved-test-key",
      notify: () => {},
    });
    assert.equal(await hasOpenAI(), true);
    await runtime.models.logout("openai");
    assert.equal(await hasOpenAI(), false);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("first send creates one durable session and recovers interrupted admissions", async () => {
  const fixture = await openFixture();
  const { root, data, project, session, faux } = fixture;
  let runtime = fixture.runtime;
  try {
    const input: StartChat = {
      projectId: project.id, requestId: randomUUID(), text: "Verify the new session.",
      model: fixture.input.model, thinking: fixture.input.thinking,
    };
    await assert.rejects(runtime.start({ ...input, projectId: randomUUID() }), /Project not found/);
    await assert.rejects(runtime.start({ ...input, text: "  " }), /Enter a message/);
    const unavailable = { ...input, model: { ...input.model, id: "unavailable-model" } };
    await assert.rejects(runtime.start(unavailable), /model is unavailable/);
    assert.deepEqual(runtime.listSessions(project.id).map(({ id }) => id), [session.id]);

    faux.setResponses([toolResponse("bash", { command: "printf 'Started in the project'" }), fauxAssistantMessage("Done.")]);
    const [started, duplicate] = await Promise.all([runtime.start(input), runtime.start(input)]);
    assert.deepEqual(duplicate, started);
    assert.equal(started.id, input.requestId);
    assert.equal(started.title, input.text);
    const selection = { projectId: project.id, sessionId: started.id };
    const view = await waitForView(runtime, selection, view => Boolean(answerWithTiming(view, "Done.")));
    assert.equal(view.messages.filter(message => message.requestId === input.requestId).length, 1);
    assert.ok(view.messages.some(message => message.blocks.some(block =>
      block.type === "tool" && block.name === "bash" && block.output === "Started in the project")));

    const interrupted = await runtime.createSession(project.id);
    await runtime.close();
    // Simulate a stop before acknowledgement for one admission and before
    // Durable committed for another. Both mappings are still provisional.
    {
      using metadata = new DatabaseSync(join(data, "workspace.sqlite"));
      metadata.prepare("UPDATE sessions SET startPending = 1 WHERE id IN (?, ?)").run(started.id, interrupted.id);
    }
    runtime = await fixture.open();
    assert.deepEqual(runtime.listSessions(project.id).map(({ id }) => id), [started.id, session.id]);
    assert.deepEqual(await runtime.start(unavailable), started);
    const reopened = await waitForView(runtime, selection, () => true);
    assert.deepEqual(reopened.messages, view.messages);
    using metadata = new DatabaseSync(join(data, "workspace.sqlite"));
    assert.equal(metadata.prepare("SELECT 1 FROM sessions WHERE id = ?").get(interrupted.id), undefined);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent native writes capture a before-image inside the file mutation queue", async () => {
  const { root, projectDir, runtime, project, selection, input, faux } = await openFixture();
  try {
    const path = join(projectDir, "same.txt");
    await writeFile(path, "original\n");
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("write", { path: "same.txt", content: "first\n" }),
        fauxToolCall("write", { path: "same.txt", content: "second\n" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("Writes settled."),
    ]);
    const done = waitForView(runtime, selection, view => view.status === "idle" && textIn(view, "Writes settled."));
    await runtime.send(input);
    const patches = (await done).messages.flatMap(message => message.blocks.flatMap(
      block => block.type === "tool" && block.patch ? [block.patch] : [],
    ));
    assert.equal(patches.length, 2);
    const last = (await readFile(path, "utf8")).trim();
    const prior = last === "first" ? "second" : "first";
    assert.ok(patches.some(patch => patch.includes("-original\n+" + prior)));
    assert.ok(patches.some(patch => patch.includes("-" + prior + "\n+" + last)));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling a running bash call settles the watched run and stops the process", async () => {
  const { root, runtime, project, selection, input, faux, projectDir } = await openFixture();
  try {
    faux.setResponses([
      toolResponse("bash", { command: "echo started; sleep 20; touch completed" }),
    ]);
    const running = waitForView(runtime, selection, view => view.messages.some(message => message.blocks.some(
      block => block.type === "tool" && block.status === "running" && block.output?.includes("started"),
    )));
    await runtime.send({ ...input, requestId: randomUUID() });
    await running;
    await assert.rejects(runtime.send(input), /busy/i);
    const idle = waitForView(runtime, selection, view => view.status === "idle");
    await runtime.cancel(selection);
    const stopped = await idle;
    assert.equal(stopped.runOutcome?.kind, "cancelled");
    assert.equal(stopped.error, undefined);
    assert.ok(stopped.messages.every(message => message.completed === undefined));
    await assert.rejects(readFile(join(projectDir, "completed")), { code: "ENOENT" });
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("whole-run cancellation withdraws queued inputs and native continue finishes without another user message", async () => {
  const fixture = await openFixture();
  const { root, project, selection, input, faux } = fixture;
  let runtime = fixture.runtime;
  try {
    faux.setResponses([toolResponse("bash", { command: "printf 'waiting'; sleep 20" })]);
    // A continuation's native settlement proves completion even when the
    // original input came from a build without request metadata.
    await runtime.send(input);
    const originalRun = await waitForView(runtime, selection, view => view.runStartedAt !== undefined && view.messages.some(message => message.blocks.some(
      block => block.type === "tool" && block.status === "running" && block.output?.includes("waiting"),
    )));
    assert.equal(originalRun.runStartedAt, originalRun.messages.find(message => message.role === "user")?.timestamp);
    await runtime.send({ ...input, requestId: randomUUID(), delivery: "follow-up", text: "Withdraw this queued follow-up." });
    await runtime.send({ ...input, requestId: randomUUID(), delivery: "follow-up", text: "Withdraw this one too." });
    await runtime.cancel(selection);
    const cancelled = await waitForView(runtime, selection, view => view.runOutcome?.kind === "cancelled" && Boolean(view.canContinue) && view.runEndedAt !== undefined);
    assert.equal(cancelled.error, undefined);
    assert.equal(cancelled.queued, undefined);
    assert.equal(cancelled.runStartedAt, originalRun.runStartedAt);
    const nativeHarness = (runtime as unknown as { harness: Harness }).harness;
    const cancelledTask = await nativeHarness.getTask(cancelled.runOutcome!.taskId as Parameters<Harness["getTask"]>[0], BACKGROUND_CONTEXT);
    assert.equal(cancelled.runEndedAt, cancelledTask?.endedAt);
    const users = cancelled.messages.filter(message => message.role === "user");
    assert.equal(users.length, 1);
    await runtime.close();
    runtime = await fixture.open();
    const restoredCancellation = await waitForView(runtime, selection, view => Boolean(view.canContinue) && view.runEndedAt !== undefined);
    assert.equal(restoredCancellation.runOutcome?.kind, "cancelled");
    assert.deepEqual(restoredCancellation.messages, cancelled.messages);
    assert.equal(restoredCancellation.runStartedAt, cancelled.runStartedAt);
    assert.equal(restoredCancellation.runEndedAt, cancelled.runEndedAt);
    const requestId = randomUUID();
    await assert.rejects(runtime.continue({ ...selection, requestId, model: { ...input.model, id: "missing-model" }, thinking: "off" }), /unavailable/);
    faux.setResponses([
      toolResponse("bash", { command: "sleep 0.08; printf resumed" }),
      fauxAssistantMessage("Native continuation completed."),
    ]);
    const continuedAt = Date.now();
    await Promise.all([
      runtime.continue({ ...selection, requestId, model: input.model, thinking: input.thinking }),
      runtime.continue({ ...selection, requestId, model: input.model, thinking: input.thinking }),
    ]);
    const resumedRun = await waitForView(runtime, selection, view => view.status === "running" && view.runStartedAt !== undefined);
    assert.ok(resumedRun.runStartedAt! >= continuedAt);
    assert.ok(resumedRun.runStartedAt! > originalRun.runStartedAt!);
    const completed = await waitForView(runtime, selection, view => Boolean(answerWithTiming(view, "Native continuation completed.")) && view.runEndedAt !== undefined);
    const answer = answerWithTiming(completed, "Native continuation completed.")!;
    assert.equal(answer.completed, true);
    assert.ok(answer.durationMs! >= 80);
    assert.deepEqual(completed.messages.filter(message => message.role === "user"), users);
    assert.equal(completed.runOutcome, undefined);
    assert.equal(completed.canContinue, undefined);
    assert.equal(completed.runStartedAt, resumedRun.runStartedAt);
    assert.equal(completed.runEndedAt! - completed.runStartedAt!, answer.durationMs);
    assert.equal(faux.state.callCount, 3, "An idempotent Continue does not create another generation.");
    await runtime.continue({ ...selection, requestId, model: { ...input.model, id: "missing-model" }, thinking: "off" });
    await assert.rejects(runtime.continue({ ...selection, requestId: randomUUID() }), /no unfinished response/);
    assert.equal(faux.state.callCount, 3);
    const branch = await runtime.fork(selection, answer.entryId!);
    const forked = await waitForView(runtime, { projectId: project.id, sessionId: branch.id }, () => true);
    assert.equal(answerWithTiming(forked, "Native continuation completed.")?.durationMs, answer.durationMs);
    await runtime.close();
    runtime = await fixture.open();
    const reopened = await waitForView(runtime, selection, () => true);
    assert.deepEqual(reopened.messages, completed.messages);
    assert.equal(reopened.runStartedAt, completed.runStartedAt);
    assert.equal(reopened.runEndedAt, completed.runEndedAt);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling one owned live tool leaves the agent and follow-up queue running", async () => {
  const { root, runtime, project, selection, input, faux } = await openFixture();
  const next = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let sawAbortedTool = false;
  try {
    faux.setResponses([
      toolResponse("bash", { command: "printf 'cancel this tool'; sleep 20" }),
      async request => {
        sawAbortedTool = request.messages.some(message => message.role === "toolResult" && message.isError);
        next.resolve();
        await release.promise;
        return fauxAssistantMessage("Finished after the tool was cancelled.");
      },
      fauxAssistantMessage("The queued follow-up was preserved."),
    ]);
    await runtime.send({ ...input, requestId: randomUUID() });
    const running = await waitForView(runtime, selection, view => view.messages.some(message => message.blocks.some(
      block => block.type === "tool" && block.taskId !== undefined && block.output?.includes("cancel this tool"),
    )));
    const tool = running.messages.flatMap(message => message.blocks).find(block => block.type === "tool" && block.taskId !== undefined);
    assert.ok(tool?.type === "tool" && tool.taskId);
    const generation = runtime.sessionActivities().find(item => item.sessionId === selection.sessionId);
    assert.ok(generation);
    await assert.rejects(runtime.cancelTask({ ...selection, taskId: generation.taskId }), /does not belong/);
    const other = await runtime.createSession(project.id);
    await assert.rejects(runtime.cancelTask({ ...selection, sessionId: other.id, taskId: tool.taskId }), /does not belong/);
    const otherProject = runtime.addProject(root);
    await assert.rejects(runtime.cancelTask({ ...selection, projectId: otherProject.id, taskId: tool.taskId }), /Session not found/);
    await runtime.send({ ...input, requestId: randomUUID(), delivery: "follow-up", text: "Keep this follow-up." });
    await runtime.cancelTask({ ...selection, taskId: tool.taskId });
    await next.promise;
    const afterTool = await waitForView(runtime, selection, view => Boolean(view.queued?.length)
      && view.messages.some(message => message.blocks.some(block => block.type === "tool" && block.cancelled === true)));
    assert.equal(afterTool.status, "running");
    assert.equal(afterTool.runOutcome, undefined);
    assert.equal(afterTool.canContinue, undefined);
    assert.equal(sawAbortedTool, true);
    const settledTool = afterTool.messages.flatMap(message => message.blocks).find(block => block.type === "tool" && block.id === tool.id);
    assert.ok(settledTool?.type === "tool");
    assert.equal(settledTool.taskId, undefined);
    assert.equal(settledTool.cancelling, undefined);
    await runtime.cancelTask({ ...selection, taskId: tool.taskId });
    release.resolve();
    const finished = await waitForView(runtime, selection, view => Boolean(answerWithTiming(view, "The queued follow-up was preserved.")));
    assert.equal(finished.messages.filter(message => message.role === "user").length, 2);
    assert.equal(finished.runOutcome, undefined);
    assert.equal(finished.queued, undefined);
  } finally {
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native continue applies the newly selected model and thinking level after a failed request", async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-continue-model-"));
  const projectDir = join(root, "project");
  await mkdir(projectDir);
  const faux = fauxProvider({ models: [{ id: "before", reasoning: true }, { id: "after", reasoning: true }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await Runtime.open(join(root, "app"), {}, models);
  const project = runtime.addProject(projectDir);
  const session = await runtime.createSession(project.id);
  const selection = { projectId: project.id, sessionId: session.id };
  let resumedModel: string | undefined;
  let resumedThinking: string | undefined;
  try {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid credentials" }),
      (_request, options, _state, model) => {
        resumedModel = model.id;
        resumedThinking = options?.reasoning;
        return fauxAssistantMessage("Recovered with the selected model.");
      },
    ]);
    await runtime.send({ ...selection, text: "Complete this work.", requestId: randomUUID(),
      model: { provider: faux.getModel("before")!.provider, id: "before" }, thinking: "off" });
    const failed = await waitForView(runtime, selection, view => Boolean(view.canContinue));
    assert.equal(failed.runOutcome?.kind, "failed");
    await runtime.continue({ ...selection, requestId: randomUUID(),
      model: { provider: faux.getModel("after")!.provider, id: "after" }, thinking: "high" });
    const finished = await waitForView(runtime, selection, view => Boolean(answerWithTiming(view, "Recovered with the selected model.")));
    assert.equal(resumedModel, "after");
    assert.equal(resumedThinking, "high");
    assert.equal(finished.thinking, "high");
    assert.equal(finished.messages.filter(message => message.role === "user").length, 1);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native continue places retained queued inputs even when the prior context ends in an answer", async () => {
  const { root, runtime, selection, input, faux } = await openFixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let sawQueuedInput = false;
  try {
    faux.setResponses([
      async () => {
        started.resolve();
        await release.promise;
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid credentials" });
      },
      request => {
        sawQueuedInput = request.messages.some(message => message.role === "user" && message.content === "Retained native follow-up.");
        return fauxAssistantMessage("Finished the retained queued input.");
      },
    ]);
    await runtime.send({ ...input, requestId: randomUUID() });
    await started.promise;
    await runtime.send({ ...input, requestId: randomUUID(), delivery: "follow-up", text: "Retained native follow-up." });
    release.resolve();
    const failed = await waitForView(runtime, selection, view => view.status === "idle" && Boolean(view.queued?.length));
    // Preserve an actual native failed-run inbox, then make its current model
    // context end in a completed answer through a native context/history write.
    const harness = (runtime as unknown as { harness: Harness }).harness;
    const task = await harness.getTask(failed.failureTaskId as Parameters<Harness["getTask"]>[0], BACKGROUND_CONTEXT);
    assert.ok(task);
    const conversation = await harness.conversation(task.conversationId, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    await conversation.commit(tx => tx.appendEntry(conversation.id, { kind: "pi.assistant",
      model: [fauxAssistantMessage("The earlier text reached its output limit.", { stopReason: "length" })] }), BACKGROUND_CONTEXT);
    const contextBefore = await conversation.context(BACKGROUND_CONTEXT);
    assert.equal(contextBefore.messages.findLast(message => message.role !== "system")?.role, "assistant");
    const ready = await waitForView(runtime, selection, view => Boolean(view.canContinue)
      && textIn(view, "The earlier text reached its output limit."));
    assert.equal(ready.queued?.length, 1);
    await runtime.continue({ ...selection, requestId: randomUUID() });
    const finished = await waitForView(runtime, selection, view => Boolean(answerWithTiming(view, "Finished the retained queued input.")));
    assert.equal(sawQueuedInput, true);
    assert.equal(finished.messages.filter(message => message.role === "user").length, 2,
      "Only native placement of the retained input adds a user message.");
    assert.equal(finished.queued, undefined);
    assert.equal(finished.canContinue, undefined);
  } finally {
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unfinished generation resumes after closing and reopening the SQLite store", async () => {
  const fixture = await openFixture();
  const { root, project, selection, input, faux } = fixture;
  let runtime = fixture.runtime;
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  try {
    faux.setResponses([async () => {
      started.resolve();
      await release.promise;
      return fauxAssistantMessage("Old generation.");
    }]);
    await runtime.send({ ...input, requestId: randomUUID() });
    await started.promise;
    const original = await waitForView(runtime, selection, view => view.runStartedAt !== undefined);
    assert.equal(original.runStartedAt, original.messages.find(message => message.role === "user")?.timestamp);
    const otherSession = await runtime.createSession(project.id);
    const otherView = await waitForView(runtime, { ...selection, sessionId: otherSession.id }, () => true);
    assert.equal(otherView.runStartedAt, undefined);
    const reattached = await waitForView(runtime, selection, () => true);
    assert.equal(reattached.runStartedAt, original.runStartedAt);
    // Let the in-flight test provider settle when Durable aborts its stream on close.
    const closing = runtime.close();
    release.resolve();
    await closing;

    faux.setResponses([async () => {
      resumed.resolve();
      await finish.promise;
      return fauxAssistantMessage("Recovered generation.");
    }]);
    runtime = await fixture.open();
    await resumed.promise;
    const reopened = await waitForView(runtime, selection, view => view.runStartedAt !== undefined);
    assert.equal(reopened.runStartedAt, original.runStartedAt);
    finish.resolve();
    const recovered = await waitForView(runtime, selection, view => view.runEndedAt !== undefined && view.messages.some(message => message.blocks.some(
      block => block.type === "text" && block.text === "Recovered generation.",
    )));
    assert.equal(recovered.messages.filter(message => message.role === "user").length, 1);
    assert.equal(recovered.runStartedAt, original.runStartedAt);
    assert.ok(recovered.runEndedAt! >= recovered.runStartedAt!);
  } finally {
    release.resolve();
    finish.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an afterRun clock reconstructs the new Continue admission after inputs clear and storage reopens", async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-after-run-clock-"));
  const faux = fauxProvider({ models: [{ id: "after-run-clock" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const waitTask = defineTask<null, { phase: "wait" }, null>({
    name: "run-clock-wait", version: 1, initial: () => ({ phase: "wait" }),
    phases: { wait: async (_task, runtime, context) => { await runtime.sleepUntil(Date.now() + 60_000, { phase: "wait" }, context); } },
    abort: async (_task, runtime, context) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); },
  });
  const registry = createRegistry();
  const extension = defineExtension({ name: "run-clock", tasks: [waitTask],
    hooks: [hook(GenerationTask, { afterRun: () => ({ tasks: [runEndTask(waitTask, null)] }) })] });
  registry.install(extension);
  const open = async () => Harness.open(await openNodeSqliteStorage(join(root, "native.sqlite")), { models, registry }, BACKGROUND_CONTEXT);
  let harness = await open();
  try {
    const model = faux.getModel();
    let conversation = await harness.createConversation({ ownership: { kind: "ownerless" },
      agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off", extensions: [extension] } }, BACKGROUND_CONTEXT);
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid credentials" }),
      fauxAssistantMessage("Answered before afterRun work."),
    ]);
    const originalRequest = randomUUID();
    const original = await conversation.submit({ type: "input", content: "Do this work.", requestId: originalRequest,
      entry: { kind: inputEntryKind, data: { requestId: originalRequest } } }, BACKGROUND_CONTEXT);
    const failed = await original.wait(BACKGROUND_CONTEXT);
    assert.equal(failed.status, "unanswered");
    assert.ok(failed.type === "input" && failed.entry !== undefined);
    await new Promise(resolve => setTimeout(resolve, 10));
    const requestId = randomUUID();
    const startedAt = Date.now();
    const id = await conversation.commit(async tx => {
      const submissionId = await conversation.submit(tx, { type: "continue", requestId });
      await tx.appendEntry(conversation.id, { kind: continueEntryKind, data: { requestId, startedAt } });
      return submissionId;
    }, BACKGROUND_CONTEXT);
    const answered = await (await harness.submission(id, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT);
    assert.ok(answered.type === "continue" && answered.status === "done");
    const live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
    assert.ok(live?.run?.afterRun);
    assert.deepEqual(live.run.inputs, []);
    assert.equal(live.run.first, failed.entry, "Continue inherits the failed history boundary, not its new clock origin.");
    assert.equal(await activeRunStartedAt(harness, conversation, live.run, BACKGROUND_CONTEXT), startedAt);
    const conversationId = conversation.id;
    await harness.close(BACKGROUND_CONTEXT);
    harness = await open();
    conversation = (await harness.conversation(conversationId, BACKGROUND_CONTEXT))!;
    const reopened = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
    assert.ok(reopened?.run?.afterRun);
    assert.equal(await activeRunStartedAt(harness, conversation, reopened.run, BACKGROUND_CONTEXT), startedAt);
    await conversation.abort(BACKGROUND_CONTEXT, { background: true });
    const ended = await harness.getTask(reopened.run.taskId, BACKGROUND_CONTEXT);
    assert.ok(ended?.endedAt);
    const completion = await completedRun(harness, ended, BACKGROUND_CONTEXT, answered.answer);
    assert.equal(completion?.startedAt, startedAt);
    assert.equal(completion?.durationMs, ended.endedAt - startedAt, "Aborted afterRun work ends at the native task terminal time.");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["send", "start"] as const) test(`quit sees a ${mode} admission during model validation and closes only after it commits`, async t => {
  const fixture = await openFixture();
  let runtime = fixture.runtime;
  const validating = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requestId = randomUUID();
  let admission: Promise<unknown> | undefined;
  try {
    assert.equal(runtime.hasActiveWork(), false);
    await runtime.renameSession(fixture.selection, "Idle renamed session");
    assert.equal(runtime.hasActiveWork(), false, "ordinary metadata changes are not running model work");
    const available = runtime.models.getAvailableOfType.bind(runtime.models);
    t.mock.method(runtime.models, "getAvailableOfType", async (...args: Parameters<typeof available>) => {
      validating.resolve();
      await release.promise;
      return available(...args);
    });
    fixture.faux.setResponses([fauxAssistantMessage("Accepted before exit.")]);
    const input = { ...fixture.input, requestId };
    admission = mode === "send" ? runtime.send(input) : runtime.start(input);
    assert.equal(runtime.hasActiveWork(), true, "sending work is active before its first asynchronous step");
    await validating.promise;
    assert.deepEqual(runtime.sessionActivities(), [], "no Durable generation exists during model validation");
    assert.equal(runtime.hasActiveWork(), true);
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await assert.rejects(runtime.send({ ...input, requestId: randomUUID() }), /finishing/);
    await assert.rejects(runtime.createSession(fixture.project.id), /finishing/);
    assert.equal(closed, false, "close must not shut the store underneath an accepted send");
    release.resolve();
    const admitted = await admission;
    await closing;

    fixture.faux.setResponses([fauxAssistantMessage("Recovered accepted input.")]);
    runtime = await fixture.open();
    const selection = mode === "start"
      ? { projectId: fixture.project.id, sessionId: (admitted as { id: string }).id } : fixture.selection;
    const view = await waitForView(runtime, selection, view => view.status === "idle" && view.messages.length >= 2);
    assert.equal(view.messages.filter(message => message.role === "user").length, 1);
    assert.equal(view.messages.find(message => message.role === "user")?.requestId, requestId);
  } finally {
    release.resolve();
    await admission?.catch(() => {});
    await runtime.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function textIn(view: ChatView, text: string): boolean {
  return view.messages.some(message => message.blocks.some(block => block.type === "text" && block.text === text));
}

function answerWithTiming(view: ChatView, text: string) {
  return view.messages.find(message => message.durationMs !== undefined
    && message.blocks.some(block => block.type === "text" && block.text === text));
}

test("completed interactions and whole-run timing survive reopen and respect the selected fork boundary", async () => {
  const fixture = await openFixture();
  const { root, project, selection, input, faux } = fixture;
  let runtime = fixture.runtime;
  const generating = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    faux.setResponses([
      () => toolResponse("bash", { command: "sleep 0.08; printf 'timed tool'" }),
      () => toolResponse("bash", { command: "printf 'second timed tool'" }),
      async () => {
        generating.resolve();
        await release.promise;
        return fauxAssistantMessage("Timed work finished.");
      },
    ]);
    const clockViews: ChatView[] = [];
    const clockWatch = await runtime.watch(selection, view => { clockViews.push(view); });
    const finished = waitForView(runtime, selection, view => Boolean(answerWithTiming(view, "Timed work finished.")) && view.runEndedAt !== undefined);
    void finished.catch(() => {});
    await runtime.send({ ...input, requestId: randomUUID() });
    await generating.promise;
    const running = await waitForView(runtime, selection, view => view.status === "running" && view.runStartedAt !== undefined);
    assert.equal(running.runStartedAt, running.messages.find(message => message.role === "user")?.timestamp,
      "Tool-round task handoffs keep the original native placement time.");
    assert.ok(running.messages.every(message => message.durationMs === undefined));
    assert.ok(running.messages.every(message => message.completed === undefined));
    await new Promise(resolve => setTimeout(resolve, 50));
    release.resolve();
    const view = await finished;
    const answer = answerWithTiming(view, "Timed work finished.")!;
    assert.equal(view.runStartedAt, running.runStartedAt);
    assert.equal(view.runEndedAt! - view.runStartedAt!, answer.durationMs);
    const firstClock = clockViews.findIndex(view => view.runStartedAt !== undefined);
    assert.ok(firstClock >= 0);
    assert.ok(clockViews.slice(firstClock).every(view => view.runStartedAt === running.runStartedAt),
      "The current run clock stays present while its native terminal time is read.");
    clockWatch.dispose();
    assert.equal(answer.completed, true);
    assert.ok(answer.durationMs! >= 120, "Whole-run time includes earlier tools and the final generation wait.");
    const firstInput = view.messages.find(message => message.role === "user")!;
    assert.ok(answer.durationMs! >= answer.timestamp! - firstInput.timestamp!);
    assert.equal(view.messages.filter(message => message.durationMs !== undefined).length, 1);
    assert.deepEqual(view.messages.filter(message => message.completed).map(message => message.id), [answer.id]);
    assert.ok(view.messages.every(message => typeof message.timestamp === "number" && Number.isFinite(message.timestamp)));
    const tool = view.messages.find(message => message.blocks.some(block => block.type === "tool"));
    assert.ok(tool?.entryId && answer.entryId);

    const before = await runtime.fork(selection, tool.entryId);
    const beforeView = await waitForView(runtime, { projectId: project.id, sessionId: before.id }, () => true);
    assert.ok(beforeView.messages.every(message => message.durationMs === undefined));
    assert.ok(beforeView.messages.every(message => message.completed === undefined));
    assert.equal(beforeView.runStartedAt, undefined);
    assert.equal(beforeView.runEndedAt, undefined);
    const after = await runtime.fork(selection, answer.entryId);
    const afterView = await waitForView(runtime, { projectId: project.id, sessionId: after.id }, () => true);
    assert.equal(answerWithTiming(afterView, "Timed work finished.")?.durationMs, answer.durationMs);
    assert.equal(answerWithTiming(afterView, "Timed work finished.")?.completed, true);
    assert.equal(afterView.runStartedAt, view.runStartedAt);
    assert.equal(afterView.runEndedAt, view.runEndedAt);

    await runtime.close();
    runtime = await fixture.open();
    const reopened = await waitForView(runtime, selection, () => true);
    assert.deepEqual(reopened.messages, view.messages);
    assert.equal(reopened.runStartedAt, view.runStartedAt);
    assert.equal(reopened.runEndedAt, view.runEndedAt);

    const nextGeneration = Promise.withResolvers<void>();
    const nextRelease = Promise.withResolvers<void>();
    const nextViews: ChatView[] = [];
    const nextWatch = await runtime.watch(selection, view => { nextViews.push(view); });
    try {
      faux.setResponses([async () => {
        nextGeneration.resolve();
        await nextRelease.promise;
        return fauxAssistantMessage("The next request failed.", { stopReason: "error", errorMessage: "Invalid credentials" });
      }]);
      await runtime.send({ ...input, requestId: randomUUID(), text: "Start the next interaction." });
      await nextGeneration.promise;
      const nextRunning = await waitForView(runtime, selection, view => view.status === "running" && view.runStartedAt !== undefined);
      assert.notEqual(nextRunning.runStartedAt, view.runStartedAt);
      assert.equal(nextRunning.runEndedAt, undefined);
      assert.ok(nextViews.filter(view => view.status === "running").every(next => next.runStartedAt !== view.runStartedAt && next.runEndedAt === undefined),
        "A new native run never displays the older frozen range while its start is loading.");
      assert.deepEqual(nextRunning.messages.filter(message => message.completed).map(message => message.id), [answer.id]);
      assert.equal(answerWithTiming(nextRunning, "Timed work finished.")?.durationMs, answer.durationMs);
      nextRelease.resolve();
      const failed = await waitForView(runtime, selection, view => view.status === "idle" && Boolean(view.error) && view.runEndedAt !== undefined);
      assert.equal(failed.runStartedAt, nextRunning.runStartedAt);
      const native = (runtime as unknown as { harness: Harness }).harness;
      const failedTask = await native.getTask(failed.failureTaskId as Parameters<Harness["getTask"]>[0], BACKGROUND_CONTEXT);
      assert.equal(failed.runEndedAt, failedTask?.endedAt);
      assert.deepEqual(failed.messages.filter(message => message.completed).map(message => message.id), [answer.id]);
      assert.ok(failed.messages.filter(message => message.id !== answer.id).every(message => message.durationMs === undefined));
      const failedOutput = failed.messages.find(message => message.blocks.some(
        block => block.type === "text" && block.text === "The next request failed.",
      ));
      assert.ok(failedOutput);
      assert.equal(failedOutput.entryId, undefined);
      nextWatch.dispose();
      await runtime.close();
      runtime = await fixture.open();
      const reopenedFailure = await waitForView(runtime, selection, () => true);
      assert.equal(reopenedFailure.runStartedAt, failed.runStartedAt);
      assert.equal(reopenedFailure.runEndedAt, failed.runEndedAt);
    } finally {
      nextWatch.dispose();
      nextRelease.resolve();
    }
  } finally {
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an idle fork opens promptly while its parent's visible tool round is still running", async () => {
  const { root, runtime, project, selection, input, faux } = await openFixture();
  let watching: ReturnType<Runtime["watch"]> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    faux.setResponses([toolResponse("bash", { command: "printf 'parent-tool-ready'; sleep 20" })]);
    await runtime.send({ ...input, requestId: randomUUID() });
    const parent = await waitForView(runtime, selection, view => view.messages.some(message => message.blocks.some(
      block => block.type === "tool" && block.taskId !== undefined && block.output?.includes("parent-tool-ready"),
    )));
    const message = parent.messages.find(message => message.entryId !== undefined && message.blocks.some(
      block => block.type === "tool" && block.taskId !== undefined,
    ));
    assert.ok(message?.entryId);
    const tool = message.blocks.find(block => block.type === "tool" && block.taskId !== undefined);
    assert.ok(tool?.type === "tool" && tool.taskId);
    const branch = await runtime.fork(selection, message.entryId);
    let forkView: ChatView | undefined;
    watching = runtime.watch({ projectId: project.id, sessionId: branch.id }, view => { forkView = view; });
    await Promise.race([
      watching,
      new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("Fork watch waited for the parent's active tool.")), 2_000); }),
    ]);
    clearTimeout(deadline);
    assert.equal(forkView?.status, "idle");
    assert.equal(forkView?.runStartedAt, undefined);
    assert.equal(forkView?.runEndedAt, undefined);
    assert.ok(forkView?.messages.every(message => message.blocks.every(block => block.type !== "tool" || block.taskId === undefined)));
    const harness = (runtime as unknown as { harness: Harness }).harness;
    const parentTool = await harness.getTask(tool.taskId as Parameters<Harness["getTask"]>[0], BACKGROUND_CONTEXT);
    assert.notEqual(parentTool?.state.status, "terminal", "The fork must open before its parent's work finishes.");
  } finally {
    clearTimeout(deadline);
    await runtime.cancel(selection);
    await watching?.then(watch => watch.dispose()).catch(() => {});
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a native final answer stays completed when an earlier legacy boundary leaves its timing unknown", async () => {
  const fixture = await openFixture();
  const { root, selection, input, faux } = fixture;
  let runtime = fixture.runtime;
  try {
    faux.setResponses([fauxAssistantMessage("Legacy reply."), fauxAssistantMessage("Confirmed final answer.")]);
    await runtime.send(input);
    await waitForView(runtime, selection, view => view.status === "idle" && textIn(view, "Legacy reply."));
    await runtime.send({ ...input, requestId: randomUUID(), text: "A new native input." });
    const view = await waitForView(runtime, selection, view => view.messages.some(message => message.completed
      && message.blocks.some(block => block.type === "text" && block.text === "Confirmed final answer.")));
    const answer = view.messages.find(message => message.completed)!;
    assert.equal(answer.durationMs, undefined);
    assert.deepEqual(view.messages.filter(message => message.completed).map(message => message.id), [answer.id]);
    await runtime.close();
    runtime = await fixture.open();
    const reopened = await waitForView(runtime, selection, () => true);
    assert.deepEqual(reopened.messages, view.messages);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native transcript retains watched entries, loads earlier history, and forks a selected entry", async () => {
  const { root, runtime, project, selection, input, faux } = await openFixture();
  try {
    let ongoing!: ChatView;
    const live = await runtime.watch(selection, view => { ongoing = view; });
    const turns = 55;
    faux.setResponses(Array.from({ length: turns }, (_, index) => fauxAssistantMessage(`Reply ${index}.`)));
    for (let index = 0; index < turns; index++) {
      const answer = waitForView(runtime, selection, view => view.status === "idle" && textIn(view, `Reply ${index}.`));
      await runtime.send({ ...input, text: `Turn ${index}.` });
      await answer;
    }
    assert.ok(textIn(ongoing, "Turn 0."));
    live.dispose();

    let reopened!: ChatView;
    const history = await runtime.watch(selection, view => { reopened = view; });
    assert.equal(reopened.hasEarlier, true);
    assert.ok(!textIn(reopened, "Turn 0."));
    while (reopened.hasEarlier) await history.loadEarlier();
    assert.ok(textIn(reopened, "Turn 0."));
    assert.equal(reopened.hasEarlier, undefined);
    const firstAnswer = reopened.messages.find(message => message.blocks.some(
      block => block.type === "text" && block.text === "Reply 0.",
    ));
    assert.ok(firstAnswer?.entryId);
    history.dispose();

    let restored!: ChatView;
    const anchored = await runtime.watch(selection, view => { restored = view; }, undefined, firstAnswer.entryId);
    assert.ok(textIn(restored, "Turn 0."));
    assert.ok(textIn(restored, "Reply 0."));
    assert.ok(textIn(restored, "Reply 54."));
    assert.ok(restored.gaps?.length);
    assert.ok(!textIn(restored, "Reply 25."));
    await anchored.fillGap(restored.gaps[0]!);
    assert.ok(textIn(restored, "Reply 25."));
    anchored.dispose();

    const forked = await runtime.fork(selection, firstAnswer.entryId);
    assert.notEqual(forked.id, selection.sessionId);
    assert.equal(forked.projectId, selection.projectId);
    const branch = { projectId: selection.projectId, sessionId: forked.id };
    const forkView = await waitForView(runtime, branch, () => true);
    assert.ok(textIn(forkView, "Reply 0."));
    assert.ok(!textIn(forkView, "Turn 1."));
    assert.deepEqual(forkView.model, input.model);

    faux.setResponses([
      toolResponse("bash", { command: "pwd" }),
      fauxAssistantMessage("Branch is independent."),
    ]);
    const answer = waitForView(runtime, branch, view => view.status === "idle" && textIn(view, "Branch is independent."));
    await runtime.send({ ...input, ...branch });
    const command = (await answer).messages.find(message => message.blocks.some(
      block => block.type === "tool" && block.status === "done" && block.output?.trim() === project.directory,
    ));
    assert.ok(command?.entryId);
    const beforeResult = await runtime.fork(branch, command.entryId);
    const exactFork = await waitForView(runtime, { ...branch, sessionId: beforeResult.id }, () => true);
    assert.ok(exactFork.messages.some(message => message.blocks.some(
      block => block.type === "tool" && block.output === "Tool result unavailable in this fork.",
    )));
    assert.ok(!textIn(exactFork, "Branch is independent."));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native automatic compaction preserves history and continues the waiting request", async () => {
  const { root, runtime, project, selection, input, faux } = await openFixture();
  const release = Promise.withResolvers<void>();
  try {
    // Keep the first two requests below the faux model's background threshold.
    // The next input crosses its blocking threshold while an older turn can be cut.
    const earlier = "Earlier working context." + " .".repeat(60_000);
    const latest = "Latest working context." + " .".repeat(60_000);
    const next = "Continue the work." + " .".repeat(99_000);
    faux.setResponses([fauxAssistantMessage("Earlier reply."), fauxAssistantMessage("Latest reply.")]);
    for (const [text, answer] of [[earlier, "Earlier reply."], [latest, "Latest reply."]]) {
      const idle = waitForView(runtime, selection, view => view.status === "idle" && textIn(view, answer));
      await runtime.send({ ...input, text });
      await idle;
    }
    let nextRequestUsedSummary = false;
    const summary = "A native summary of the earlier work.";
    faux.setResponses([
      async () => {
        await release.promise;
        return fauxAssistantMessage(summary);
      },
      request => {
        const userText = request.messages.flatMap(message => message.role !== "user" ? []
          : typeof message.content === "string" ? [message.content]
          : message.content.flatMap(block => block.type === "text" ? [block.text] : []));
        nextRequestUsedSummary = userText.some(text => text.includes(summary))
          && userText.includes(next) && !userText.includes(earlier);
        return fauxAssistantMessage("Continued after compaction.");
      },
    ]);
    const active = waitForView(runtime, selection, view => view.activity?.kind === "compacting");
    await runtime.send({ ...input, text: next });
    await active;
    release.resolve();
    const view = await waitForView(runtime, selection, view => view.status === "idle" && textIn(view, "Continued after compaction."));
    assert.equal(nextRequestUsedSummary, true);
    assert.ok(textIn(view, earlier));
    assert.ok(textIn(view, "Earlier reply."));
    assert.ok(textIn(view, "Latest reply."));
    assert.ok(textIn(view, next));
  } finally {
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native steering and follow-up queue the selected delivery and deduplicate request IDs", async () => {
  const { root, runtime, project, selection, input, faux } = await openFixture();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const steered = Promise.withResolvers<void>();
  const finishCurrent = Promise.withResolvers<void>();
  const following = Promise.withResolvers<void>();
  const finishFollowing = Promise.withResolvers<void>();
  const first = { ...input, requestId: randomUUID() };
  try {
    faux.setResponses([
      async () => {
        started.resolve();
        await release.promise;
        return toolResponse("bash", { command: "printf ready" });
      },
      async () => { steered.resolve(); await finishCurrent.promise; return fauxAssistantMessage("Current run finished."); },
      async () => { following.resolve(); await finishFollowing.promise; return fauxAssistantMessage("Follow-up finished."); },
    ]);
    await runtime.send(first);
    await started.promise;
    const initialRun = await waitForView(runtime, selection, view => view.runStartedAt !== undefined);
    const queuedAt = Date.now();
    const followUp = { ...input, delivery: "follow-up" as const, requestId: randomUUID(), text: "Next run." };
    const steer = { ...input, delivery: "steer" as const, requestId: randomUUID(), text: "Steer this run." };
    await runtime.send(followUp);
    await runtime.send(steer);
    await runtime.send(steer);
    const queued = await waitForView(runtime, selection, view => view.queued?.length === 2);
    assert.deepEqual(queued.queued?.map(item => item.delivery), ["follow-up", "steer"]);
    await new Promise(resolve => setTimeout(resolve, 80));
    release.resolve();
    await steered.promise;
    const steeredRun = await waitForView(runtime, selection, view => view.messages.some(message => message.requestId === steer.requestId));
    assert.equal(steeredRun.runStartedAt, initialRun.runStartedAt);
    finishCurrent.resolve();
    await following.promise;
    const followUpRun = await waitForView(runtime, selection, view => view.messages.some(message => message.requestId === followUp.requestId)
      && view.runStartedAt !== undefined);
    assert.equal(followUpRun.runStartedAt, followUpRun.messages.find(message => message.requestId === followUp.requestId)?.timestamp);
    assert.ok(followUpRun.runStartedAt! >= queuedAt + 60, "The live clock excludes the queued follow-up's waiting time.");
    assert.notEqual(followUpRun.runStartedAt, initialRun.runStartedAt);
    finishFollowing.resolve();
    const completed = await waitForView(runtime, selection, view => Boolean(answerWithTiming(view, "Follow-up finished.")));
    assert.deepEqual(
      completed.messages.filter(message => message.role === "user").map(message => message.requestId),
      [first.requestId, steer.requestId, followUp.requestId],
    );
    const firstMessage = completed.messages.find(message => message.requestId === first.requestId)!;
    const steerMessage = completed.messages.find(message => message.requestId === steer.requestId)!;
    const followUpMessage = completed.messages.find(message => message.requestId === followUp.requestId)!;
    const currentAnswer = answerWithTiming(completed, "Current run finished.")!;
    const followUpAnswer = answerWithTiming(completed, "Follow-up finished.")!;
    assert.ok(currentAnswer.durationMs! >= steerMessage.timestamp! - firstMessage.timestamp!, "Steering does not reset the interaction's start.");
    assert.ok(followUpMessage.timestamp! - queuedAt >= 60, "A queued message gets its native timestamp when placed.");
    assert.ok(followUpAnswer.durationMs! < followUpMessage.timestamp! - queuedAt, "Follow-up timing excludes its queue wait.");
    assert.equal(completed.messages.filter(message => message.durationMs !== undefined).length, 2);
    assert.equal(completed.queued, undefined);
    await assert.rejects(runtime.send({ ...steer, requestId: randomUUID() }), /idle/i);
  } finally {
    release.resolve();
    finishCurrent.resolve();
    finishFollowing.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("queued inputs can be steered, removed, edited with attachments, and reordered before native placement", async () => {
  const { root, runtime, project, selection, input, faux } = await openFixture();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const image = {
    mimeType: "image/png" as const,
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRckAAAAASUVORK5CYII=",
  };
  try {
    const otherSession = await runtime.createSession(project.id);
    faux.setResponses([
      async () => {
        started.resolve();
        await release.promise;
        return toolResponse("bash", { command: "printf ready" });
      },
      fauxAssistantMessage("Steered run finished."),
      fauxAssistantMessage("Reordered follow-up finished."),
      fauxAssistantMessage("Last follow-up finished."),
    ]);
    await runtime.send(input);
    await started.promise;

    const edit = { ...input, delivery: "follow-up" as const, text: "Original description", images: [image], requestId: randomUUID() };
    const remove = { ...input, delivery: "follow-up" as const, text: "Discard this", requestId: randomUUID() };
    const move = { ...input, delivery: "follow-up" as const, text: "Move before the edit", requestId: randomUUID() };
    const steer = { ...input, delivery: "follow-up" as const, text: "Steer this run", requestId: randomUUID() };
    for (const message of [edit, remove, move, steer]) await runtime.send(message);
    const queued = await waitForView(runtime, selection, view => view.queued?.length === 4);
    const [editId, removeId, moveId, steerId] = queued.queued!.map(item => item.id);
    assert.equal(queued.canSteerQueued, true);
    assert.deepEqual(await runtime.readQueuedInput({ ...selection, id: editId }), { text: edit.text, hasImages: true });
    await assert.rejects(runtime.readQueuedInput({ ...selection, sessionId: otherSession.id, id: editId }), /no longer in the queue/);
    await assert.rejects(runtime.updateQueuedInput({ ...selection, id: moveId, action: "edit", text: " " }), /Enter a message/);

    const editedText = "Updated description. ".repeat(20);
    await runtime.updateQueuedInput({ ...selection, id: editId, action: "edit", text: "" });
    assert.deepEqual(await runtime.readQueuedInput({ ...selection, id: editId }), { text: "", hasImages: true });
    await runtime.updateQueuedInput({ ...selection, id: editId, action: "edit", text: editedText });
    await runtime.updateQueuedInput({ ...selection, id: removeId, action: "remove" });
    await runtime.updateQueuedInput({ ...selection, id: steerId, action: "steer" });
    const reorder = { ...selection, id: moveId, action: "move", targetId: editId, position: "before" } as const;
    await runtime.updateQueuedInput(reorder);
    await runtime.updateQueuedInput(reorder);
    await assert.rejects(runtime.updateQueuedInput({ ...reorder, targetId: steerId }), /this part of the queue/);
    // Retries of the original send must not resurrect, overwrite, or duplicate a queued input.
    for (const message of [edit, remove, steer]) await runtime.send(message);
    const updated = await waitForView(runtime, selection, () => true);
    assert.deepEqual(updated.queued?.map(item => [item.id, item.delivery]), [
      [steerId, "steer"], [moveId, "follow-up"], [editId, "follow-up"],
    ]);
    assert.deepEqual(await runtime.readQueuedInput({ ...selection, id: editId }), { text: editedText, hasImages: true });
    await assert.rejects(runtime.readQueuedInput({ ...selection, id: removeId }), /no longer in the queue/);

    release.resolve();
    const completed = await waitForView(runtime, selection, view => view.status === "idle" && textIn(view, "Last follow-up finished."));
    assert.deepEqual(completed.messages.filter(message => message.role === "user").map(message => message.requestId),
      [undefined, steer.requestId, move.requestId, edit.requestId]);
    assert.deepEqual(completed.messages.find(message => message.requestId === edit.requestId)?.blocks,
      [{ type: "text", text: editedText }, { type: "image", ...image }]);
    assert.equal(completed.queued, undefined);
    await assert.rejects(runtime.updateQueuedInput({ ...selection, id: editId, action: "remove" }), /no longer in the queue/);
  } finally {
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an idle conversation accepts a late follow-up but cannot steer retained input from a failed run", async () => {
  const { root, runtime, project, selection, input, faux } = await openFixture();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  try {
    faux.setResponses([
      async () => {
        started.resolve();
        await release.promise;
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid credentials" });
      },
    ]);
    await runtime.send(input);
    await started.promise;
    const followUp = { ...input, delivery: "follow-up" as const, text: "Retained after failure" };
    await runtime.send(followUp);
    release.resolve();
    const failed = await waitForView(runtime, selection, view => view.status === "idle" && Boolean(view.error));
    const queuedId = failed.queued?.[0]?.id;
    assert.ok(queuedId);
    assert.equal(failed.canSteerQueued, undefined);
    await assert.rejects(runtime.updateQueuedInput({ ...selection, id: queuedId, action: "steer" }), /no current task/);
    assert.deepEqual(await runtime.readQueuedInput({ ...selection, id: queuedId }), { text: followUp.text, hasImages: false });
    await runtime.updateQueuedInput({ ...selection, id: queuedId, action: "remove" });

    faux.setResponses([fauxAssistantMessage("Late follow-up finished.")]);
    await runtime.send({ ...followUp, text: "Admitted after the prior run ended" });
    const completed = await waitForView(runtime, selection, view => view.status === "idle" && textIn(view, "Late follow-up finished."));
    assert.ok(textIn(completed, "Admitted after the prior run ended"));
    assert.equal(completed.queued, undefined);
  } finally {
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an abrupt host exit resumes a committed request without admitting a duplicate", async () => {
  const fixture = await openFixture();
  const { root, data, project, selection, input, faux } = fixture;
  let runtime = fixture.runtime;
  const requestId = randomUUID();
  let child: ReturnType<typeof fork> | undefined;
  try {
    await runtime.close();
    child = fork(fileURLToPath(new URL("./support/crash-generation.ts", import.meta.url)), [
      data, selection.projectId, selection.sessionId, requestId,
    ], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const [started] = await once(child, "message", { signal: AbortSignal.timeout(8_000) });
    assert.equal(started, "in-flight");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");

    faux.setResponses([fauxAssistantMessage("Recovered after host crash.")]);
    runtime = await fixture.open();
    await runtime.send({ ...input, text: "Recover this request.", requestId });
    await runtime.send({ ...input, model: { ...input.model, id: "removed-from-catalog" }, requestId });
    const view = await waitForView(runtime, selection, result => result.status === "idle"
      && textIn(result, "Recovered after host crash."));
    assert.equal(view.messages.filter(message => message.requestId === requestId).length, 1);
    assert.equal(faux.state.callCount, 1);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
