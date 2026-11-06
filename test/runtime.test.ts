import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Selection } from "../src/shared/api.js";
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
  return { root, projectDir, faux, runtime, project, session, selection, input: input(selection, "Check this project."), open };
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
    faux.setResponses([
      toolResponse("edit", { path: "hello.txt", edits: [{ oldText: "before", newText: "after" }] }),
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
    const blocks = view.messages.flatMap(message => message.blocks);
    assert.ok(blocks.some(block => block.type === "tool" && block.name === "edit" && block.patch?.includes("+after")));
    assert.ok(blocks.some(block => block.type === "tool" && block.name === "bash" && block.output?.trim() === "after"));
    assert.equal(await readFile(join(projectDir, "hello.txt"), "utf8"), "after\n");
    await runtime.close();

    runtime = await fixture.open();
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

test("pi-ai credentials are explicit and changing them updates model availability", async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-credentials-"));
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "ambient-test-key";
  const runtime = await Runtime.open(root);
  try {
    assert.ok((await runtime.listModels()).some(model => model.provider === "openai"));
    assert.ok(!(await runtime.listModels()).some(model => model.configured));
    await runtime.saveKey("openai", "saved-test-key");
    assert.ok((await runtime.listModels()).some(model => model.provider === "openai" && model.configured));
    await runtime.saveKey("openai", "");
    assert.ok(!(await runtime.listModels()).some(model => model.configured));
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
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
