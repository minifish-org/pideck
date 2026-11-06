import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ChatView, Selection } from "../src/shared/api.js";
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

test("trust, ownership, built-in coding tools, watch reattachment, and durable reopen", async () => {
  const fixture = await openFixture();
  const { root, projectDir, project, session, selection, input, faux } = fixture;
  let runtime = fixture.runtime;
  const secretVariable = "PIDECK_TEST_PROVIDER_SECRET";
  process.env[secretVariable] = "not-for-the-shell";
  try {
    await assert.rejects(runtime.send(input), /Trust this project/);
    assert.throws(() => runtime.requireTrustedProject(project.id), /Trust this project/);
    const otherProject = runtime.addProject(root);
    await assert.rejects(runtime.watch({ ...selection, projectId: otherProject.id }, () => {}), /Session not found/);
    runtime.trustProject(project.id);
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

    runtime = await fixture.open();
    assert.equal(runtime.deviceId(), deviceId);
    assert.equal(runtime.listSessions(project.id)[0].id, session.id);
    assert.equal(runtime.listProjects().find(item => item.id === project.id)?.trusted, true);
    const reopened = await waitForView(runtime, selection, () => true);
    assert.deepEqual(reopened.messages, view.messages);
    assert.deepEqual(reopened.model, input.model);

    await rename(projectDir, join(root, "old-project"));
    await mkdir(projectDir);
    assert.throws(() => runtime.requireTrustedProject(project.id), /folder changed/);
    assert.equal(runtime.addProject(projectDir).trusted, false);
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

test("concurrent native writes capture a before-image inside the file mutation queue", async () => {
  const { root, projectDir, runtime, project, selection, input, faux } = await openFixture();
  try {
    runtime.trustProject(project.id);
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
    runtime.trustProject(project.id);
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
    runtime.trustProject(project.id);
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

test("native transcript retains watched entries, loads earlier history, and forks a selected entry", async () => {
  const { root, runtime, project, selection, input, faux } = await openFixture();
  try {
    runtime.trustProject(project.id);
    let ongoing!: ChatView;
    const live = await runtime.watch(selection, view => { ongoing = view; });
    const turns = 31;
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
    await history.loadEarlier();
    assert.ok(textIn(reopened, "Turn 0."));
    assert.equal(reopened.hasEarlier, undefined);
    const firstAnswer = reopened.messages.find(message => message.blocks.some(
      block => block.type === "text" && block.text === "Reply 0.",
    ));
    assert.ok(firstAnswer?.entryId);
    history.dispose();

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

test("native manual compaction reports progress and preserves prior transcript entries", async () => {
  const { root, runtime, project, selection, input, faux } = await openFixture();
  const release = Promise.withResolvers<void>();
  try {
    runtime.trustProject(project.id);
    faux.setResponses([fauxAssistantMessage("Short reply.")]);
    const short = waitForView(runtime, selection, view => view.status === "idle" && textIn(view, "Short reply."));
    await runtime.send(input);
    await short;
    assert.equal(await runtime.compact(selection), "no-change");
    faux.setResponses([fauxAssistantMessage("Earlier reply."), fauxAssistantMessage("Latest reply.")]);
    for (const [label, answer] of [["Earlier", "Earlier reply."], ["Latest", "Latest reply."]]) {
      const idle = waitForView(runtime, selection, view => view.status === "idle" && textIn(view, answer));
      await runtime.send({ ...input, text: label + " .".repeat(42_000) });
      await idle;
    }
    let modelSawInstructions = false;
    faux.setResponses([async request => {
      modelSawInstructions = request.messages.some(message => message.role === "user" && (
        typeof message.content === "string" ? message.content : message.content.flatMap(
          block => block.type === "text" ? [block.text] : [],
        ).join(" ")
      ).includes("Keep the project rule."));
      await release.promise;
      return fauxAssistantMessage("A native summary.");
    }]);
    const active = waitForView(runtime, selection, view => view.activity?.kind === "compacting");
    const compaction = runtime.compact(selection, "Keep the project rule.");
    await active;
    release.resolve();
    assert.equal(await compaction, "compacted");
    assert.equal(modelSawInstructions, true);
    const view = await waitForView(runtime, selection, view => view.status === "idle");
    assert.ok(textIn(view, "Earlier reply."));
    assert.ok(textIn(view, "Latest reply."));
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
  try {
    runtime.trustProject(project.id);
    faux.setResponses([
      async () => {
        started.resolve();
        await release.promise;
        return toolResponse("bash", { command: "printf ready" });
      },
      fauxAssistantMessage("Current run finished."),
      fauxAssistantMessage("Follow-up finished."),
    ]);
    await runtime.send(input);
    await started.promise;
    const followUp = { ...input, delivery: "follow-up" as const, requestId: randomUUID(), text: "Next run." };
    const steer = { ...input, delivery: "steer" as const, requestId: randomUUID(), text: "Steer this run." };
    await runtime.send(followUp);
    await runtime.send(steer);
    await runtime.send(steer);
    const queued = await waitForView(runtime, selection, view => view.queued?.length === 2);
    assert.deepEqual(queued.queued?.map(item => item.delivery), ["follow-up", "steer"]);
    release.resolve();
    const completed = await waitForView(runtime, selection, view => view.status === "idle" && textIn(view, "Follow-up finished."));
    assert.deepEqual(
      completed.messages.filter(message => message.role === "user").map(message => message.requestId),
      [undefined, steer.requestId, followUp.requestId],
    );
    assert.equal(completed.queued, undefined);
    await assert.rejects(runtime.send({ ...steer, requestId: randomUUID() }), /idle/i);
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
    runtime.trustProject(project.id);
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
