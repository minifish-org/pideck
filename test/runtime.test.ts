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
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ChatView, Selection, StartChat } from "../src/shared/api.js";
import { Runtime } from "../src/host/runtime.js";
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
    await runtime.send(input);
    await running;
    await assert.rejects(runtime.send(input), /busy/i);
    const idle = waitForView(runtime, selection, view => view.status === "idle");
    await runtime.cancel(selection);
    const stopped = await idle;
    assert.match(stopped.error ?? "", /stopped/i);
    await assert.rejects(readFile(join(projectDir, "completed")), { code: "ENOENT" });
  } finally {
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
  try {
    faux.setResponses([async () => {
      started.resolve();
      await release.promise;
      return fauxAssistantMessage("Old generation.");
    }]);
    await runtime.send(input);
    await started.promise;
    // Let the in-flight test provider settle when Durable aborts its stream on close.
    const closing = runtime.close();
    release.resolve();
    await closing;

    faux.setResponses([fauxAssistantMessage("Recovered generation.")]);
    runtime = await fixture.open();
    const recovered = await waitForView(runtime, selection, view => view.messages.some(message => message.blocks.some(
      block => block.type === "text" && block.text === "Recovered generation.",
    )));
    assert.equal(recovered.messages.filter(message => message.role === "user").length, 1);
  } finally {
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

function textIn(view: ChatView, text: string): boolean {
  return view.messages.some(message => message.blocks.some(block => block.type === "text" && block.text === text));
}

function answerWithTiming(view: ChatView, text: string) {
  return view.messages.find(message => message.durationMs !== undefined
    && message.blocks.some(block => block.type === "text" && block.text === text));
}

test("message timestamps and whole-run timing survive reopen and respect the selected fork boundary", async () => {
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
    const finished = waitForView(runtime, selection, view => Boolean(answerWithTiming(view, "Timed work finished.")));
    void finished.catch(() => {});
    await runtime.send({ ...input, requestId: randomUUID() });
    await generating.promise;
    const running = await waitForView(runtime, selection, view => view.status === "running");
    assert.ok(running.messages.every(message => message.durationMs === undefined));
    await new Promise(resolve => setTimeout(resolve, 50));
    release.resolve();
    const view = await finished;
    const answer = answerWithTiming(view, "Timed work finished.")!;
    assert.ok(answer.durationMs! >= 120, "Whole-run time includes earlier tools and the final generation wait.");
    const firstInput = view.messages.find(message => message.role === "user")!;
    assert.ok(answer.durationMs! >= answer.timestamp! - firstInput.timestamp!);
    assert.equal(view.messages.filter(message => message.durationMs !== undefined).length, 1);
    assert.ok(view.messages.every(message => typeof message.timestamp === "number" && Number.isFinite(message.timestamp)));
    const tool = view.messages.find(message => message.blocks.some(block => block.type === "tool"));
    assert.ok(tool?.entryId && answer.entryId);

    const before = await runtime.fork(selection, tool.entryId);
    const beforeView = await waitForView(runtime, { projectId: project.id, sessionId: before.id }, () => true);
    assert.ok(beforeView.messages.every(message => message.durationMs === undefined));
    const after = await runtime.fork(selection, answer.entryId);
    const afterView = await waitForView(runtime, { projectId: project.id, sessionId: after.id }, () => true);
    assert.equal(answerWithTiming(afterView, "Timed work finished.")?.durationMs, answer.durationMs);

    await runtime.close();
    runtime = await fixture.open();
    const reopened = await waitForView(runtime, selection, () => true);
    assert.deepEqual(reopened.messages, view.messages);
  } finally {
    release.resolve();
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
  const first = { ...input, requestId: randomUUID() };
  try {
    faux.setResponses([
      async () => {
        started.resolve();
        await release.promise;
        return toolResponse("bash", { command: "printf ready" });
      },
      fauxAssistantMessage("Current run finished."),
      fauxAssistantMessage("Follow-up finished."),
    ]);
    await runtime.send(first);
    await started.promise;
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
