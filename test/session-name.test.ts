import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { firstSessionTitle, sessionTitleLimit, untitledSession } from "../src/shared/session-title.js";
import { fauxRuntime, waitForView } from "./support/faux-runtime.js";

test("the first admitted prompt names an untitled session and is recovered before reopening", async () => {
  const data = await mkdtemp(join(tmpdir(), "pideck-session-name-"));
  const otherDirectory = await mkdtemp(join(tmpdir(), "pideck-session-other-"));
  const fixture = fauxRuntime(data);
  let runtime = await fixture.open();
  try {
    const project = runtime.addProject(data);
    const other = runtime.addProject(otherDirectory);
    runtime.trustProject(project.id);
    const session = await runtime.createSession(project.id);
    const named = await runtime.createSession(project.id, "Saved legacy name");
    const selection = { projectId: project.id, sessionId: session.id };
    const currentTitle = (id: string) => runtime.listSessions(project.id).find(item => item.id === id)?.title;
    assert.equal(currentTitle(session.id), untitledSession);
    assert.throws(() => runtime.renameSession({ ...selection, projectId: other.id }, "Wrong project"), /not found/i);
    assert.throws(() => runtime.renameSession(selection, " \u202e "), /enter a session name/i);

    await assert.rejects(runtime.send({ ...fixture.input(selection, "Rejected name"), model: { provider: "missing", id: "model" } }),
      /unavailable/i);
    assert.equal(currentTitle(session.id), untitledSession);
    fixture.faux.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("Done again.")]);
    const first = waitForView(runtime, selection, view => view.status === "idle" && view.messages.length >= 2);
    await runtime.send(fixture.input(selection, "\n  ## Fix   🔎 the search  \u202e\nFurther details"));
    await first;
    const second = waitForView(runtime, selection, view => view.status === "idle" && view.messages.length >= 4);
    await runtime.send(fixture.input(selection, "A later instruction"));
    await second;
    assert.equal(currentTitle(session.id), "Fix 🔎 the search");

    // Simulate stopping after Durable commits the input and before the title projection is written.
    await runtime.close();
    const metadata = new DatabaseSync(join(data, "workspace.sqlite"));
    metadata.prepare("UPDATE sessions SET title = ?, autoTitlePending = 1 WHERE id = ?").run(untitledSession, session.id);
    metadata.close();
    runtime = await fixture.open();
    assert.equal(currentTitle(session.id), "Fix 🔎 the search");
    assert.equal(currentTitle(named.id), "Saved legacy name");
    const renamed = runtime.renameSession(selection, "  Explicit title   ");
    assert.equal(renamed.title, "Explicit title");
    await runtime.close();
    const oldMetadata = new DatabaseSync(join(data, "workspace.sqlite"));
    oldMetadata.exec("ALTER TABLE sessions DROP COLUMN autoTitlePending");
    oldMetadata.close();
    runtime = await fixture.open();
    assert.equal(currentTitle(session.id), "Explicit title");
    assert.equal(currentTitle(named.id), "Saved legacy name");
  } finally {
    await runtime.close();
    await Promise.all([rm(data, { recursive: true, force: true }), rm(otherDirectory, { recursive: true, force: true })]);
  }
});

test("title generation bounds Unicode without splitting a grapheme", () => {
  const family = "👩‍👩‍👦";
  const title = firstSessionTitle(family.repeat(100));
  assert.ok(title.length <= sessionTitleLimit);
  assert.equal(title, family.repeat(9) + "…");
  assert.equal(firstSessionTitle(""), "Image request");
});
