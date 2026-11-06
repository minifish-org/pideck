import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ChatView } from "../src/shared/api.js";
import { fauxRuntime, toolResponse, waitForView } from "./support/faux-runtime.js";

function textIn(view: ChatView, text: string): boolean {
  return view.messages.some(message => message.blocks.some(block => block.type === "text" && block.text === text));
}

test("removing an active session stops Bash and purges its owned overflow log, then a removed workspace reopens untrusted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-remove-runtime-"));
  const directory = join(root, "workspace");
  const data = join(root, "data");
  await mkdir(directory);
  const fixture = fauxRuntime(data);
  let runtime = await fixture.open();
  try {
    const project = runtime.addProject(directory);
    runtime.trustProject(project.id);
    const target = await runtime.createSession(project.id, "Remove me");
    const independent = await runtime.createSession(project.id, "Keep until workspace removal");
    const selection = { projectId: project.id, sessionId: target.id };
    const independentSelection = { projectId: project.id, sessionId: independent.id };
    fixture.faux.setResponses([
      toolResponse("bash", { command: "printf '%070000d' 0" }),
      fauxAssistantMessage("Overflow finished."),
    ]);
    const settled = waitForView(runtime, selection, view => view.status === "idle" && textIn(view, "Overflow finished."));
    await runtime.send(fixture.input(selection, "Generate Bash overflow."));
    const bash = (await settled).messages.flatMap(message => message.blocks)
      .find(block => block.type === "tool" && block.name === "bash");
    assert.ok(bash?.type === "tool" && bash.status === "done");
    const spill = bash.output?.match(/Full output: ([^\n]+)/)?.[1];
    assert.ok(spill && spill.startsWith(join(data, "tool-output") + sep));
    assert.equal((await readFile(spill)).length, 70_000);

    fixture.faux.setResponses([toolResponse("bash", {
      command: 'printf "%s\\n" "$$" > bash-pid; echo running-removal; sleep 30; touch should-not-exist',
    })]);
    const active = waitForView(runtime, selection, view => view.messages.some(message => message.blocks.some(
      block => block.type === "tool" && block.status === "running" && block.output?.includes("running-removal"),
    )));
    await runtime.send(fixture.input(selection, "Start a cancellable tool."));
    await active;
    const pid = Number(await readFile(join(directory, "bash-pid"), "utf8"));
    const plan = runtime.removalPlan(selection);
    assert.deepEqual((await runtime.remove(selection, plan.scope)).sessionIds, [target.id]);
    if (process.platform !== "win32") assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(readFile(join(directory, "should-not-exist")), { code: "ENOENT" });
    await assert.rejects(readFile(spill), { code: "ENOENT" });
    await assert.rejects(runtime.watch(selection, () => {}), /session not found/i);
    assert.equal((await waitForView(runtime, independentSelection, () => true)).status, "idle");

    const workspace = { projectId: project.id };
    const projectPlan = runtime.removalPlan(workspace);
    assert.deepEqual((await runtime.remove(workspace, projectPlan.scope)).sessionIds, [independent.id]);
    await runtime.close();
    runtime = await fixture.open();
    assert.deepEqual(runtime.listProjects(), []);
    assert.equal(Number(await readFile(join(directory, "bash-pid"), "utf8")), pid);
    const readded = runtime.addProject(directory);
    assert.notEqual(readded.id, project.id);
    assert.equal(readded.trusted, false);
    assert.deepEqual(runtime.listSessions(readded.id), []);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("parent sessions require branch-first removal and an empty workspace can be removed during unrelated work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-remove-forks-"));
  const directory = join(root, "workspace");
  const emptyDirectory = join(root, "empty");
  const otherDirectory = join(root, "other");
  await Promise.all([mkdir(directory), mkdir(emptyDirectory), mkdir(otherDirectory)]);
  const fixture = fauxRuntime(join(root, "data"));
  const runtime = await fixture.open();
  try {
    const project = runtime.addProject(directory);
    runtime.trustProject(project.id);
    const parent = await runtime.createSession(project.id, "Parent");
    const selection = { projectId: project.id, sessionId: parent.id };
    fixture.faux.setResponses([fauxAssistantMessage("Fork point.")]);
    const finished = waitForView(runtime, selection, view => view.status === "idle" && textIn(view, "Fork point."));
    await runtime.send(fixture.input(selection, "Create forkable history."));
    const point = (await finished).messages.find(message => message.role === "assistant")?.entryId;
    assert.ok(point);
    const fork = await runtime.fork(selection, point);
    const child = { ...selection, sessionId: fork.id };
    const nested = await runtime.fork(child, point);
    const blockedPlan = runtime.removalPlan(selection);
    assert.deepEqual(blockedPlan.blockingBranches, [
      { id: nested.id, title: nested.title }, { id: fork.id, title: fork.title },
    ]);
    await assert.rejects(runtime.remove(selection, blockedPlan.scope), /branches first/i);
    const grandchild = { ...selection, sessionId: nested.id };
    await runtime.remove(grandchild, runtime.removalPlan(grandchild).scope);
    const childPlan = runtime.removalPlan(child);
    await runtime.remove(child, childPlan.scope);
    assert.equal(runtime.removalPlan(selection).sessionCount, 1);

    const empty = runtime.addProject(emptyDirectory);
    const other = runtime.addProject(otherDirectory);
    const otherSession = await runtime.createSession(other.id);
    await writeFile(join(emptyDirectory, "keep.txt"), "keep");
    fixture.faux.setResponses([toolResponse("bash", { command: "echo unrelated-live; sleep 30" })]);
    const running = waitForView(runtime, selection, view => view.messages.some(message => message.blocks.some(
      block => block.type === "tool" && block.status === "running" && block.output?.includes("unrelated-live"),
    )));
    await runtime.send(fixture.input(selection, "Keep running during empty workspace removal."));
    await running;
    const blocked = { projectId: other.id, sessionId: otherSession.id };
    await assert.rejects(runtime.remove(blocked, runtime.removalPlan(blocked).scope), /work in other sessions/i);
    assert.equal(runtime.listSessions(other.id)[0]?.id, otherSession.id);
    const target = { projectId: empty.id };
    await runtime.remove(target, runtime.removalPlan(target).scope);
    const stillRunning = await waitForView(runtime, selection, () => true);
    assert.equal(stillRunning.status, "running");
    assert.equal(await readFile(join(emptyDirectory, "keep.txt"), "utf8"), "keep");
    await runtime.cancel(selection);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("reopening finishes the file cleanup left by an interrupted removal", async () => {
  const data = await mkdtemp(join(tmpdir(), "pideck-removal-cleanup-"));
  const oldOutputDirectory = await mkdtemp(join(tmpdir(), "tmp-"));
  const oldSpill = join(oldOutputDirectory, `pi-output-${randomUUID()}.log`);
  const appOutput = join(data, "tool-output", "9001");
  const fixture = fauxRuntime(data);
  let runtime = await fixture.open();
  try {
    await runtime.close();
    await mkdir(appOutput, { recursive: true });
    await writeFile(join(appOutput, "abandoned"), "Pending removal");
    await writeFile(oldSpill, "Pending removal");
    const metadata = new DatabaseSync(join(data, "workspace.sqlite"));
    try {
      metadata.prepare("INSERT INTO tool_output_cleanup (path) VALUES (?)").run(oldSpill);
    } finally {
      metadata.close();
    }
    runtime = await fixture.open();
    await assert.rejects(readFile(join(appOutput, "abandoned")), { code: "ENOENT" });
    await assert.rejects(readFile(oldSpill), { code: "ENOENT" });
    const snapshot = new DatabaseSync(join(data, "workspace.sqlite"), { readOnly: true });
    try {
      assert.equal(snapshot.prepare("SELECT count(*) AS pending FROM tool_output_cleanup").get()?.pending, 0);
    } finally {
      snapshot.close();
    }
  } finally {
    await runtime.close();
    await rm(data, { recursive: true, force: true });
    await rm(oldOutputDirectory, { recursive: true, force: true });
  }
});
