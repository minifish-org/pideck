import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ChatView, QueueEditRef, Selection } from "../src/shared/api";
import { validPayload } from "../src/main/validation";
import { fauxRuntime, toolResponse, waitForView } from "./support/faux-runtime";

const textIn = (view: ChatView, text: string) => view.messages.some(message => message.blocks.some(block => block.type === "text" && block.text === text));
const image = { mimeType: "image/png" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRckAAAAASUVORK5CYII=" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pideck-queue-edit-"));
  const projectDir = join(root, "project");
  await mkdir(projectDir);
  const engine = fauxRuntime(join(root, "app"));
  const lifetime = randomUUID();
  let runtime = await engine.open(lifetime);
  const project = runtime.addProject(projectDir);
  const session = await runtime.createSession(project.id);
  const selection: Selection = { projectId: project.id, sessionId: session.id };
  return { ...engine, selection, project, lifetime, get runtime() { return runtime; },
    input: (text: string) => ({ ...engine.input(selection, text), requestId: randomUUID() }),
    async reopen(nextLifetime = lifetime, closedWindows?: readonly number[]) { await runtime.close(); runtime = await engine.open(nextLifetime, closedWindows); },
    async close() { await runtime.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("editing a follow-up preserves its native suffix while the current run and earlier input finish", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const owner = 7;
  try {
    f.faux.setResponses([
      async () => { started.resolve(); await release.promise; return fauxAssistantMessage("Main finished."); },
      fauxAssistantMessage("Prefix finished."), fauxAssistantMessage("Edited finished."),
      fauxAssistantMessage("Tail finished."), fauxAssistantMessage("New input finished."),
    ]);
    const main = f.input("Current work");
    await f.runtime.send(main);
    await started.promise;
    const prefix = { ...f.input("Earlier input"), delivery: "follow-up" as const };
    const target = { ...f.input("Original text"), delivery: "follow-up" as const, images: [image] };
    const tail = { ...f.input("Later input"), delivery: "follow-up" as const };
    for (const input of [prefix, target, tail]) await f.runtime.send(input);
    const queued = await waitForView(f.runtime, f.selection, view => view.queued?.length === 3);
    const id = queued.queued![1].id;
    const edit: QueueEditRef = { ...f.selection, id, token: randomUUID() };
    const snapshots: ChatView[] = [];
    const observer = await f.runtime.watch(f.selection, view => snapshots.push(view));
    assert.deepEqual(await f.runtime.startQueueEdit(edit, owner), { token: edit.token, text: target.text, images: target.images });
    observer.dispose();
    assert.ok(snapshots.length >= 2);
    assert.ok(snapshots.every(view => view.queued?.some(item => item.id === id)), "One atomic claim must not transiently hide the edited input.");
    assert.deepEqual(await f.runtime.startQueueEdit({ ...edit, token: randomUUID() }, owner),
      { token: edit.token, text: target.text, images: target.images }, "A lost start acknowledgement recovers the existing token.");
    await assert.rejects(f.runtime.startQueueEdit(edit, owner + 1), /already being edited/);
    await assert.rejects(f.runtime.updateQueuedInput({ ...f.selection, id, action: "remove" }), /Finish editing/);
    release.resolve();
    const waiting = await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Prefix finished."));
    assert.deepEqual(waiting.messages.filter(message => message.role === "user").map(message => message.requestId), [main.requestId, prefix.requestId]);
    assert.deepEqual(waiting.queued?.map(item => [item.id, item.editing]), [[id, true], [queued.queued![2].id, undefined]]);

    // Even a stale renderer sending the idle "send" delivery must not bypass the held input.
    const late = f.input("Admitted while idle and editing");
    await f.runtime.send(late);
    await f.runtime.send(late);
    await assert.rejects(f.runtime.send({ ...f.input("Invalid idle steer"), delivery: "steer" }), /idle/i);
    const withLate = await waitForView(f.runtime, f.selection, view => view.queued?.length === 3);
    assert.deepEqual(withLate.messages.filter(message => message.role === "user").map(message => message.requestId), [main.requestId, prefix.requestId]);
    await assert.rejects(f.runtime.finishQueueEdit({ ...edit, token: randomUUID(), text: "Wrong token" }, owner), /no longer active/);
    await assert.rejects(f.runtime.finishQueueEdit({ ...edit, text: "Wrong owner" }, owner + 1), /no longer active/);
    await f.runtime.finishQueueEdit({ ...edit, text: "Saved text" }, owner);
    await f.runtime.finishQueueEdit({ ...edit, text: "Duplicate must not replace saved text" }, owner);
    await f.runtime.send(target);
    const completed = await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "New input finished."));
    assert.deepEqual(completed.messages.filter(message => message.role === "user").map(message => message.requestId),
      [main.requestId, prefix.requestId, target.requestId, tail.requestId, late.requestId]);
    assert.deepEqual(completed.messages.find(message => message.requestId === target.requestId)?.blocks,
      [{ type: "text", text: "Saved text" }, { type: "image", ...target.images[0] }]);
    assert.equal(completed.queued, undefined);
    await assert.rejects(f.runtime.startQueueEdit({ ...edit, token: randomUUID() }, owner), /no longer in the queue/);
  } finally { release.resolve(); await f.close(); }
});

test("an image-only queue edit returns every attachment and permits saving without text", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  try {
    f.faux.setResponses([
      async () => { started.resolve(); await release.promise; return fauxAssistantMessage("Main finished."); },
      fauxAssistantMessage("Images received."),
    ]);
    await f.runtime.send(f.input("Current work")); await started.promise;
    const target = { ...f.input(""), delivery: "follow-up" as const, images: [image, image] };
    await f.runtime.send(target);
    const queued = await waitForView(f.runtime, f.selection, view => view.queued?.length === 1);
    const edit = { ...f.selection, id: queued.queued![0].id, token: randomUUID() };
    const content = { text: "", images: target.images };
    assert.deepEqual(await f.runtime.readQueuedInput(edit), content);
    assert.deepEqual(await f.runtime.startQueueEdit(edit, 1), { token: edit.token, ...content });
    assert.deepEqual(await f.runtime.readQueuedInput(edit), content, "Parking an edit keeps its full attachments readable.");
    await f.runtime.finishQueueEdit({ ...edit, text: "" }, 1);
    release.resolve();
    const done = await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Images received."));
    assert.deepEqual(done.messages.find(message => message.requestId === target.requestId)?.blocks,
      target.images.map(image => ({ type: "image", ...image })));
  } finally { release.resolve(); await f.close(); }
});

test("a held input survives host recovery while the interrupted main run continues to its answer", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  try {
    f.faux.setResponses([async () => { started.resolve(); await release.promise; return fauxAssistantMessage("Interrupted answer."); }]);
    const main = f.input("Current interrupted work");
    const target = { ...f.input("Original held input"), delivery: "follow-up" as const };
    await f.runtime.send(main); await started.promise;
    await f.runtime.send(target);
    const queued = await waitForView(f.runtime, f.selection, view => view.queued?.length === 1);
    const edit = { ...f.selection, id: queued.queued![0].id, token: randomUUID() };
    await f.runtime.startQueueEdit(edit, 5);
    const closing = f.runtime.close(); release.resolve(); await closing;
    f.faux.setResponses([fauxAssistantMessage("Recovered current work."), fauxAssistantMessage("Original held input finished.")]);
    await f.reopen();
    const waiting = await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Recovered current work."));
    assert.equal(waiting.queued?.[0].id, edit.id);
    assert.equal(waiting.queued?.[0].editing, true);
    assert.equal(waiting.messages.some(message => message.requestId === target.requestId), false);
    await f.runtime.finishQueueEdit(edit, 5);
    const done = await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Original held input finished."));
    assert.deepEqual(done.messages.filter(message => message.role === "user").map(message => message.requestId), [main.requestId, target.requestId]);
  } finally { release.resolve(); await f.close(); }
});

test("closing an editing window while its claim is in flight cannot leave an unclaimable hold", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  try {
    f.faux.setResponses([
      async () => { started.resolve(); await release.promise; return fauxAssistantMessage("Main finished."); },
      fauxAssistantMessage("Original input finished."),
    ]);
    await f.runtime.send(f.input("Current work")); await started.promise;
    const target = { ...f.input("Original input"), delivery: "follow-up" as const };
    await f.runtime.send(target);
    const queued = await waitForView(f.runtime, f.selection, view => view.queued?.length === 1);
    const edit = { ...f.selection, id: queued.queued![0].id, token: randomUUID() };
    const claim = f.runtime.startQueueEdit(edit, 8);
    const closed = f.runtime.detachQueueEdits(8);
    const [result] = await Promise.allSettled([claim, closed]);
    if (result.status === "rejected") assert.match(String(result.reason), /window has closed/);
    release.resolve();
    await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Main finished."));
    if (result.status === "fulfilled") {
      const waiting = await waitForView(f.runtime, f.selection, () => true);
      assert.equal(waiting.queued?.[0].id, edit.id);
      assert.equal(waiting.queued?.[0].editing, true);
      assert.equal(waiting.messages.some(message => message.requestId === target.requestId), false);
      await f.runtime.startQueueEdit(edit, 9);
      await f.runtime.finishQueueEdit(edit, 9);
    }
    const done = await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Original input finished."));
    assert.equal(done.queued, undefined);
    assert.equal(done.messages.filter(message => message.requestId === target.requestId).length, 1);
    await assert.rejects(f.runtime.startQueueEdit(edit, 8), /window has closed/);
  } finally { release.resolve(); await f.close(); }
});

for (const removeProject of [false, true]) {
  test(`removing a ${removeProject ? "project" : "session"} clears its edit hold without releasing queued work`, async () => {
    const f = await fixture();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    try {
      f.faux.setResponses([async () => { started.resolve(); await release.promise; return fauxAssistantMessage("Main finished."); }]);
      await f.runtime.send(f.input("Current work")); await started.promise;
      const target = { ...f.input("Must never execute"), delivery: "follow-up" as const };
      await f.runtime.send(target);
      const queued = await waitForView(f.runtime, f.selection, view => view.queued?.length === 1);
      const edit = { ...f.selection, id: queued.queued![0].id, token: randomUUID() };
      await f.runtime.startQueueEdit(edit, 1);
      await f.runtime.detachQueueEdits(1);
      release.resolve();
      await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Main finished."));
      const targetRemoval = removeProject ? { projectId: f.project.id } : f.selection;
      const plan = f.runtime.removalPlan(targetRemoval);
      const removed = await f.runtime.remove(targetRemoval, plan.scope);
      assert.ok(removed.sessionIds.includes(f.selection.sessionId));
      await assert.rejects(f.runtime.finishQueueEdit({ ...edit, text: "Stale finish" }, 1), /not found/);
      if (removeProject) assert.equal(f.runtime.listProjects().some(project => project.id === f.project.id), false);
      else assert.equal((await f.runtime.listSessions(f.project.id)).length, 0);
    } finally { release.resolve(); await f.close(); }
  });
}

for (const action of ["cancel", "owner-close"] as const) {
  test(`${action === "cancel" ? "explicit cancel releases original text" : "closing a window preserves its edit until a new window explicitly cancels"}`, async () => {
    const f = await fixture();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    try {
      f.faux.setResponses([
        async () => { started.resolve(); await release.promise; return fauxAssistantMessage("Main finished."); },
        fauxAssistantMessage("Original finished."), fauxAssistantMessage("Tail finished."),
      ]);
      const main = f.input("Current work");
      const target = { ...f.input("Keep original"), delivery: "follow-up" as const };
      const tail = { ...f.input("Keep tail"), delivery: "follow-up" as const };
      await f.runtime.send(main); await started.promise;
      await f.runtime.send(target); await f.runtime.send(tail);
      const queued = await waitForView(f.runtime, f.selection, view => view.queued?.length === 2);
      const edit = { ...f.selection, id: queued.queued![0].id, token: randomUUID() };
      await f.runtime.startQueueEdit(edit, 4);
      release.resolve();
      await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Main finished."));
      await f.runtime.detachQueueEdits(99);
      assert.equal((await waitForView(f.runtime, f.selection, () => true)).queued?.[0].editing, true);
      if (action === "cancel") await f.runtime.finishQueueEdit(edit, 4);
      else {
        await f.runtime.detachQueueEdits(4);
        const waiting = await waitForView(f.runtime, f.selection, () => true);
        assert.deepEqual(waiting.queued?.map(item => item.id), queued.queued?.map(item => item.id));
        assert.equal(waiting.messages.some(message => message.requestId === target.requestId), false);
        await assert.rejects(f.runtime.finishQueueEdit(edit, 4), /window has closed/);
        await assert.rejects(f.runtime.startQueueEdit({ ...edit, id: queued.queued![1].id }, 5), /already being edited/);
        const freshClaim = { ...edit, token: randomUUID() };
        assert.deepEqual(await f.runtime.startQueueEdit(freshClaim, 5), { token: edit.token, text: target.text, images: [] },
          'An explicit edit action can recover a detached queue item even if the previous window draft was lost.');
        await assert.rejects(f.runtime.finishQueueEdit(freshClaim, 5), /no longer active/);
        await assert.rejects(f.runtime.startQueueEdit(edit, 6), /already being edited/);
        await f.runtime.finishQueueEdit(edit, 5);
      }
      const done = await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Tail finished."));
      assert.deepEqual(done.messages.filter(message => message.role === "user").map(message => message.requestId),
        [main.requestId, target.requestId, tail.requestId]);
      assert.equal(done.messages.find(message => message.requestId === target.requestId)?.blocks[0].type, "text");
      assert.ok(textIn(done, target.text));
      assert.equal(done.queued, undefined);
    } finally { release.resolve(); await f.close(); }
  });
}

test("editing a steer blocks later steers and follow-ups without stopping an earlier steer", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  try {
    f.faux.setResponses([
      async () => { started.resolve(); await release.promise; return toolResponse("bash", { command: "printf ready" }); },
      fauxAssistantMessage("Main and earlier steer finished."),
      fauxAssistantMessage("First released group finished."), fauxAssistantMessage("Last released group finished."),
    ]);
    const main = f.input("Current work");
    const prefix = { ...f.input("Earlier steer"), delivery: "steer" as const };
    const target = { ...f.input("Held steer"), delivery: "steer" as const };
    const followUp = { ...f.input("Follow-up behind the steer"), delivery: "follow-up" as const };
    await f.runtime.send(main); await started.promise;
    for (const input of [prefix, target, followUp]) await f.runtime.send(input);
    const queued = await waitForView(f.runtime, f.selection, view => view.queued?.length === 3);
    const edit = { ...f.selection, id: queued.queued![1].id, token: randomUUID() };
    await f.runtime.startQueueEdit(edit, 2);
    const laterSteer = { ...f.input("Later steer"), delivery: "steer" as const };
    const laterFollowUp = { ...f.input("Later follow-up"), delivery: "follow-up" as const };
    await f.runtime.send(laterSteer); await f.runtime.send(laterFollowUp);
    release.resolve();
    const waiting = await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Main and earlier steer finished."));
    assert.deepEqual(waiting.messages.filter(message => message.role === "user").map(message => message.requestId), [main.requestId, prefix.requestId]);
    assert.equal(waiting.queued?.length, 4);
    await f.runtime.finishQueueEdit(edit, 2);
    const done = await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Last released group finished."));
    assert.deepEqual(done.messages.filter(message => message.role === "user").map(message => message.requestId),
      [main.requestId, prefix.requestId, target.requestId, followUp.requestId, laterSteer.requestId, laterFollowUp.requestId]);
  } finally { release.resolve(); await f.close(); }
});

test("Stop discards parked submissions and a stale finish or request retry cannot resurrect them", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  try {
    f.faux.setResponses([async () => { started.resolve(); await release.promise; return fauxAssistantMessage("Main finished."); }]);
    await f.runtime.send(f.input("Current work")); await started.promise;
    const target = { ...f.input("Held input"), delivery: "follow-up" as const };
    const tail = { ...f.input("Held suffix"), delivery: "follow-up" as const };
    await f.runtime.send(target); await f.runtime.send(tail);
    const queued = await waitForView(f.runtime, f.selection, view => view.queued?.length === 2);
    const edit = { ...f.selection, id: queued.queued![0].id, token: randomUUID() };
    await f.runtime.startQueueEdit(edit, 1);
    await f.runtime.detachQueueEdits(1);
    release.resolve();
    await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Main finished."));
    await f.runtime.cancel(f.selection);
    await assert.rejects(f.runtime.finishQueueEdit({ ...edit, text: "Must not run" }, 2), /no longer active/);
    await f.runtime.send(target); await f.runtime.send(tail);
    const done = await waitForView(f.runtime, f.selection, view => view.status === "idle" && !view.queued?.length);
    assert.equal(done.messages.some(message => message.requestId === target.requestId || message.requestId === tail.requestId), false);
  } finally { release.resolve(); await f.close(); }
});

for (const mode of ["host", "application", "closed-window", "shutdown"] as const) {
  const sameLifetime = mode === "host";
  test(`${mode} recovery keeps input held until the editor explicitly saves or cancels`, async () => {
    const f = await fixture();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    try {
      f.faux.setResponses([async () => { started.resolve(); await release.promise; return fauxAssistantMessage("Main finished."); }]);
      const main = f.input("Current work");
      const target = { ...f.input("Original after recovery"), delivery: "follow-up" as const, images: [image] };
      const tail = { ...f.input("Tail after recovery"), delivery: "follow-up" as const };
      await f.runtime.send(main); await started.promise;
      await f.runtime.send(target); await f.runtime.send(tail);
      const queued = await waitForView(f.runtime, f.selection, view => view.queued?.length === 2);
      const edit = { ...f.selection, id: queued.queued![0].id, token: randomUUID() };
      await f.runtime.startQueueEdit(edit, 3);
      release.resolve();
      await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Main finished."));
      f.faux.setResponses([fauxAssistantMessage("Recovered target finished."), fauxAssistantMessage("Recovered tail finished.")]);
      if (mode === "shutdown") await f.runtime.detachQueueEdits();
      await f.reopen(mode === "application" || mode === "shutdown" ? randomUUID() : f.lifetime, mode === "closed-window" ? [3] : []);
      const restored = await waitForView(f.runtime, f.selection, () => true);
      assert.deepEqual(restored.queued?.map(item => item.id), queued.queued?.map(item => item.id));
      assert.equal(restored.queued?.[0].editing, true);
      assert.equal(restored.messages.some(message => message.requestId === target.requestId), false);
      const nextOwner = sameLifetime ? 3 : 4;
      if (sameLifetime) await assert.rejects(f.runtime.startQueueEdit(edit, nextOwner + 1), /already being edited/);
      else {
        await assert.rejects(f.runtime.finishQueueEdit({ ...edit, text: "Must claim before finishing" }, nextOwner), /no longer active/);
        const freshClaim = { ...edit, token: randomUUID() };
        assert.equal((await f.runtime.startQueueEdit(freshClaim, nextOwner)).token, edit.token);
        await assert.rejects(f.runtime.finishQueueEdit({ ...freshClaim, text: "New request token is not the edit token" }, nextOwner), /no longer active/);
        await assert.rejects(f.runtime.startQueueEdit(edit, nextOwner + 1), /already being edited/);
      }
      assert.deepEqual(await f.runtime.startQueueEdit(edit, nextOwner), { token: edit.token, text: target.text, images: target.images },
        "Reclaiming an edit returns its images, not just its persisted text and token.");
      const save = mode !== "application";
      await f.runtime.finishQueueEdit({ ...edit, ...(save ? { text: "Saved after recovery" } : {}) }, nextOwner);
      const done = await waitForView(f.runtime, f.selection, view => view.status === "idle" && textIn(view, "Recovered tail finished."));
      assert.equal(done.messages.filter(message => message.requestId === target.requestId).length, 1);
      assert.deepEqual(done.messages.filter(message => message.role === "user").map(message => message.requestId),
        [main.requestId, target.requestId, tail.requestId]);
      assert.deepEqual(done.messages.find(message => message.requestId === target.requestId)?.blocks,
        [{ type: "text", text: save ? "Saved after recovery" : target.text }, { type: "image", ...image }]);
      assert.equal(done.queued, undefined);
      if (!sameLifetime) await assert.rejects(f.runtime.finishQueueEdit({ ...edit, text: "Old owner must not change it" }, 3), /no longer active|window has closed/);
    } finally { release.resolve(); await f.close(); }
  });
}

test("queue edit IPC validates the selection, native input ID and opaque edit token", () => {
  const input = { projectId: randomUUID(), sessionId: randomUUID(), id: 42, token: randomUUID() };
  assert.equal(validPayload("chat:queue-edit-start", input), true);
  assert.equal(validPayload("chat:queue-edit-finish", input), true);
  assert.equal(validPayload("chat:queue-edit-finish", { ...input, text: "" }), true);
  for (const value of [{ ...input, token: "" }, { ...input, token: "other" }, { ...input, id: 0 }, { ...input, projectId: "other" }]) {
    assert.equal(validPayload("chat:queue-edit-start", value), false);
    assert.equal(validPayload("chat:queue-edit-finish", value), false);
  }
  assert.equal(validPayload("chat:queue-edit-finish", { ...input, text: "x".repeat(200_001) }), false);
});
