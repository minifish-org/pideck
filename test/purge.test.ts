import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry, defineDoc, defineExtension, defineTask, Harness, ToolResultEntry, UserEntry,
  type Conversation,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Metadata } from "../src/host/metadata.js";
import {
  conversationClosure, conversationSpillPaths, purgeConversations, reapUnmappedConversations, removeLegacySpills,
} from "../src/host/purge.js";

const context = BACKGROUND_CONTEXT;
const task = defineTask<string, { phase: "wait" }, null>({
  name: "purge-fixture",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: { wait: async () => {} },
  abort: async () => {},
});
const taskDoc = defineDoc({
  kind: "purge.fixture",
  version: 1,
  scope: "task",
  initial: () => ({ content: "" }),
  checkpointWhen: () => true,
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pideck-purge-"));
  const workspacePath = join(directory, "workspace.sqlite");
  const durablePath = join(directory, "conversations.sqlite");
  const metadata = new Metadata(workspacePath);
  const projectDir = join(directory, "project");
  const otherDir = join(directory, "other");
  await Promise.all([mkdir(projectDir), mkdir(otherDir)]);
  const project = metadata.addProject(projectDir);
  const otherProject = metadata.addProject(otherDir);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "purge-test", tasks: [task] }));
  const open = async () => Harness.open(await openNodeSqliteStorage(durablePath), {
    models: createModels(), registry,
  }, context);
  return { directory, metadata, workspacePath, durablePath, projectDir, project, otherProject, open };
}

function append(conversation: Conversation, content: string) {
  return conversation.commit(tx => tx.appendEntry(UserEntry, conversation.id, {
    model: [{ role: "user", content, timestamp: Date.now() }],
  }), context);
}

test("offline purge erases a fork and owned-conversation closure without touching surviving sessions or files", async () => {
  const f = await fixture();
  let harness = await f.open();
  let database: DatabaseSync | undefined;
  try {
    const source = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const survivor = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const deletedContent = "DELETE-" + randomUUID();
    const parentEntry = await append(source, deletedContent);
    await append(survivor, "Unrelated project history.");
    const fork = await source.fork(parentEntry.id, { ownership: { kind: "ownerless" } }, context);
    const deeper = await fork.fork(parentEntry.id, { ownership: { kind: "ownerless" } }, context);
    const taskId = await source.commit(tx => tx.createTask(task, deletedContent, { ownership: { kind: "conversation" } }), context);
    const owned = await harness.createConversation({ ownership: { kind: "task", taskId } }, context);
    await source.commit(async tx => {
      const doc = await tx.doc(taskDoc, taskId);
      doc.content = deletedContent;
    }, context);
    await source.commit(tx => tx.createSubmission({
      conversationId: source.id, type: "write", status: "done", entry: parentEntry.id, requestId: deletedContent,
    }), context);
    f.metadata.createSession(f.project.id, source.id, deletedContent);
    f.metadata.createSession(f.project.id, fork.id, "Fork title");
    f.metadata.createSession(f.project.id, deeper.id, "Nested fork title");
    f.metadata.createSession(f.otherProject.id, survivor.id, "Unrelated title");
    const file = join(f.projectDir, "keep.txt");
    await writeFile(file, "Project files stay.");
    const planned = conversationClosure(f.durablePath, [source.id]);
    assert.deepEqual(new Set(planned), new Set([source.id, fork.id, deeper.id, owned.id]));

    await harness.close(context);
    f.metadata.close();
    database = new DatabaseSync(f.workspacePath);
    assert.throws(
      () => purgeConversations(database!, f.durablePath, f.project.id, [source.id], false, [source.id]),
      /forks changed/,
    );
    assert.equal(database.prepare("SELECT count(*) AS count FROM sessions").get()?.count, 4);
    purgeConversations(database, f.durablePath, f.project.id, [source.id, fork.id, deeper.id], true, planned);
    assert.deepEqual(database.prepare("SELECT id FROM projects").all().map(row => row.id), [f.otherProject.id]);
    assert.deepEqual(database.prepare("SELECT conversationId FROM sessions").all().map(row => row.conversationId), [survivor.id]);
    assert.equal(await readFile(file, "utf8"), "Project files stay.");
    assert.ok(!(await readFile(f.durablePath)).includes(deletedContent));
    assert.ok(!(await readFile(f.workspacePath)).includes(deletedContent));

    const store = new DatabaseSync(f.durablePath, { readOnly: true });
    try {
      assert.equal(store.prepare("SELECT count(*) AS count FROM tasks").get()?.count, 0);
      assert.equal(store.prepare("SELECT count(*) AS count FROM submissions").get()?.count, 0);
      assert.equal(store.prepare("SELECT count(*) AS count FROM documents WHERE scope_kind = 'task'").get()?.count, 0);
      assert.equal(store.prepare("SELECT count(*) AS count FROM document_revisions WHERE document_id NOT IN (SELECT id FROM documents)").get()?.count, 0);
      assert.equal(store.prepare("SELECT count(*) AS count FROM record_ids WHERE id IN (?, ?)").get(taskId, parentEntry.id)?.count, 0);
    } finally {
      store.close();
    }
    harness = await f.open();
    assert.equal(await harness.conversation(source.id, context), undefined);
    const reopened = await harness.conversation(survivor.id, context);
    assert.ok(reopened);
    assert.deepEqual((await reopened.entries({}, 10, undefined, context)).items.map(entry => entry.model?.[0].content),
      ["Unrelated project history."]);
    const newEntry = await append(reopened, "Can still append.");
    assert.ok(newEntry.id > Math.max(...planned));
  } finally {
    await harness.close(context);
    database?.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("legacy spill cleanup unlinks only exact app-recorded Bash logs, without following symlinks", async () => {
  const f = await fixture();
  const harness = await f.open();
  const spillDir = await mkdtemp(join(tmpdir(), "tmp-"));
  let database: DatabaseSync | undefined;
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    f.metadata.createSession(f.project.id, conversation.id, "Legacy shell output");
    const log = join(spillDir, "pi-output-" + randomUUID() + ".log");
    const unrelated = join(spillDir, "unrelated.txt");
    const outside = join(f.projectDir, "pi-output-" + randomUUID() + ".log");
    const link = join(spillDir, "pi-output-" + randomUUID() + ".log");
    await Promise.all([writeFile(log, "full output"), writeFile(outside, "outside"), writeFile(unrelated, "unrelated")]);
    if (process.platform !== "win32") await symlink(outside, link);
    await conversation.commit(tx => tx.appendEntry(ToolResultEntry, conversation.id, {
      data: {
        diagnostics: [log, outside, unrelated, link].map(path => ({
          severity: "info" as const, code: "full_output", message: "Full output: " + path,
        })),
      },
      model: [{
        role: "toolResult", toolCallId: "test", toolName: "bash", content: [], isError: false, timestamp: Date.now(),
      }],
    }), context);

    const paths = conversationSpillPaths(f.durablePath, [conversation.id]);
    assert.deepEqual(new Set(paths), new Set([log, link]));
    await harness.close(context);
    f.metadata.close();
    database = new DatabaseSync(f.workspacePath);
    database.exec("CREATE TABLE IF NOT EXISTS tool_output_cleanup (path TEXT PRIMARY KEY) STRICT");
    assert.throws(() => purgeConversations(database!, f.durablePath, f.project.id, [conversation.id], false, [], paths));
    assert.deepEqual(database.prepare("SELECT path FROM tool_output_cleanup").all(), []);
    purgeConversations(database, f.durablePath, f.project.id, [conversation.id], false, [conversation.id], [
      ...paths, outside, unrelated,
    ]);
    const staged = database.prepare("SELECT path FROM tool_output_cleanup").all().map(row => row.path as string);
    assert.deepEqual(new Set(staged), new Set(paths));
    assert.equal(await readFile(log, "utf8"), "full output");
    removeLegacySpills(staged);
    await assert.rejects(readFile(log), { code: "ENOENT" });
    assert.equal(await readFile(outside, "utf8"), "outside");
    assert.equal(await readFile(unrelated, "utf8"), "unrelated");
    if (process.platform !== "win32") assert.equal(await readFile(link, "utf8"), "outside");
  } finally {
    await harness.close(context);
    if (database) database.close();
    else f.metadata.close();
    await rm(f.directory, { recursive: true, force: true });
    await rm(spillDir, { recursive: true, force: true });
  }
});

test("removing one session leaves the project and its independent sessions intact", async () => {
  const f = await fixture();
  const harness = await f.open();
  let database: DatabaseSync | undefined;
  try {
    const source = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const sibling = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const first = await append(source, "Source");
    const child = await source.fork(first.id, { ownership: { kind: "ownerless" } }, context);
    f.metadata.createSession(f.project.id, source.id, "Source");
    f.metadata.createSession(f.project.id, sibling.id, "Independent");
    f.metadata.createSession(f.otherProject.id, child.id, "Wrong project");
    await harness.close(context);
    f.metadata.close();
    database = new DatabaseSync(f.workspacePath);

    assert.throws(() => purgeConversations(database!, f.durablePath, f.project.id, [source.id], false, [source.id, child.id]),
      /another project/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM sessions").get()?.count, 3);
    purgeConversations(database, f.durablePath, f.otherProject.id, [child.id], false, [child.id]);
    purgeConversations(database, f.durablePath, f.project.id, [source.id], false, [source.id]);
    assert.equal(database.prepare("SELECT count(*) AS count FROM projects").get()?.count, 2);
    assert.deepEqual(database.prepare("SELECT conversationId FROM sessions").all().map(row => row.conversationId), [sibling.id]);
  } finally {
    await harness.close(context);
    database?.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("startup reaps only unmapped creation leaves and preserves surviving native ancestry and work", async () => {
  const f = await fixture();
  const database = new DatabaseSync(f.workspacePath);
  let metadataClosed = false;
  let harness: Harness | undefined;
  try {
    reapUnmappedConversations(database, f.durablePath);
    await assert.rejects(access(f.durablePath), { code: "ENOENT" });
    harness = await f.open();
    const nativeRoot = await harness.root(context);
    const mapped = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const point = await append(mapped, "Inherited source.");
    const orphan = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const orphanFork = await mapped.fork(point.id, { ownership: { kind: "ownerless" } }, context);
    const hasWork = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(hasWork, "Preserved despite no session mapping.");
    const ancestor = await mapped.fork(point.id, { ownership: { kind: "ownerless" } }, context);
    const descendant = await ancestor.fork(point.id, { ownership: { kind: "ownerless" } }, context);
    const owner = await mapped.commit(tx => tx.createTask(task, "Preserved owner", { ownership: { kind: "conversation" } }), context);
    const owned = await harness.createConversation({ ownership: { kind: "task", taskId: owner } }, context);
    f.metadata.createSession(f.project.id, mapped.id, "Mapped");
    f.metadata.createSession(f.project.id, descendant.id, "Mapped descendant");

    await harness.close(context);
    f.metadata.close();
    metadataClosed = true;
    reapUnmappedConversations(database, f.durablePath);
    reapUnmappedConversations(database, f.durablePath);
    harness = await f.open();
    for (const id of [orphan.id, orphanFork.id]) assert.equal(await harness.conversation(id, context), undefined);
    for (const id of [nativeRoot.id, mapped.id, hasWork.id, ancestor.id, descendant.id, owned.id]) {
      assert.ok(await harness.conversation(id, context), "Expected surviving conversation " + id);
    }
    const branch = await harness.conversation(descendant.id, context);
    assert.deepEqual((await branch?.entries({}, 10, undefined, context))?.items.map(entry => entry.model?.[0].content),
      ["Inherited source."]);
  } finally {
    await harness?.close(context);
    database.close();
    if (!metadataClosed) f.metadata.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
