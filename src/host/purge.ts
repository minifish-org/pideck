import { existsSync, lstatSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";

// Durable 1.5.0 has no conversation deletion API. These statements are an
// offline operation for its reviewed v2 schema, never for a live Harness.
const purgeSchemaVersion = 2;
type DatabaseName = "main" | "durable";

function hasPurgeSchema(database: DatabaseSync, schema: DatabaseName): boolean {
  if (CURRENT_SQLITE_SCHEMA_VERSION !== purgeSchemaVersion) return false;
  const table = database.prepare(`
    SELECT 1 FROM ${schema}.sqlite_schema WHERE type = 'table' AND name = 'durable_schema'
  `).get();
  return Boolean(table) && database.prepare(`
    SELECT version FROM ${schema}.durable_schema WHERE singleton = 1
  `).get()?.version === purgeSchemaVersion;
}

function checkSchema(database: DatabaseSync, schema: DatabaseName): void {
  if (!hasPurgeSchema(database, schema)) {
    throw new Error("This conversation store version cannot be removed safely.");
  }
}

function closure(database: DatabaseSync, schema: DatabaseName, roots: readonly ConversationId[]): ConversationId[] {
  const rows = database.prepare(`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM ${schema}.conversations WHERE id IN (SELECT value FROM json_each(?))
      UNION
      SELECT child.id FROM ${schema}.conversations AS child JOIN tree ON
        child.owner_conversation_id = tree.id OR json_extract(child.record, '$.parent.conversationId') = tree.id
    )
    SELECT id FROM tree ORDER BY id
  `).all(JSON.stringify(roots));
  return rows.map(row => row.id as ConversationId);
}

export function conversationClosure(durablePath: string, roots: readonly ConversationId[]): ConversationId[] {
  const database = new DatabaseSync(durablePath, { readOnly: true });
  try {
    checkSchema(database, "main");
    const conversations = closure(database, "main", roots);
    if (roots.some(root => !conversations.includes(root))) throw new Error("A conversation is missing from storage.");
    return conversations;
  } finally {
    database.close();
  }
}

function assertRollbackJournal(database: DatabaseSync, schema: DatabaseName): void {
  const mode = database.prepare(`PRAGMA ${schema}.journal_mode = DELETE`).get();
  if (mode?.journal_mode !== "delete") {
    throw new Error("The conversation store is still in use. Try removing it again.");
  }
  database.exec(`PRAGMA ${schema}.synchronous = FULL; PRAGMA ${schema}.secure_delete = ON`);
}

function sameIds(left: readonly ConversationId[], right: readonly ConversationId[]): boolean {
  const ids = new Set(left);
  return ids.size === right.length && right.every(id => ids.has(id));
}

const spillName = /^pi-output-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/i;
const spillDirectory = /^tmp-[a-z0-9]{6}$/i;
const spillLabel = "Full output: ";

function legacySpillPath(path: string): boolean {
  if (!isAbsolute(path) || path !== normalize(path) || !spillName.test(basename(path))
      || !spillDirectory.test(basename(dirname(path)))) return false;
  try {
    return realpathSync(dirname(dirname(path))) === realpathSync(tmpdir());
  } catch {
    return false;
  }
}

/** Only paths emitted by the pinned built-in Bash tool's structured diagnostic. */
export function conversationSpillPaths(durablePath: string, conversations: readonly ConversationId[]): string[] {
  const database = new DatabaseSync(durablePath, { readOnly: true });
  try {
    checkSchema(database, "main");
    const rows = database.prepare(`
      SELECT DISTINCT json_extract(diagnostic.value, '$.message') AS message
      FROM entries, json_each(entries.record, '$.data.diagnostics') AS diagnostic
      WHERE conversation_id IN (SELECT value FROM json_each(?))
        AND json_extract(entries.record, '$.kind') = 'pi.tool-result'
        AND json_extract(entries.record, '$.model[0].role') = 'toolResult'
        AND json_extract(entries.record, '$.model[0].toolName') = 'bash'
        AND json_extract(diagnostic.value, '$.code') = 'full_output'
    `).all(JSON.stringify(conversations));
    return rows.flatMap(row => {
      if (typeof row.message !== "string" || !row.message.startsWith(spillLabel)) return [];
      const path = row.message.slice(spillLabel.length);
      return legacySpillPath(path) ? [path] : [];
    });
  } finally {
    database.close();
  }
}

export function removeLegacySpills(paths: readonly string[]): void {
  for (const path of paths) {
    if (!legacySpillPath(path)) continue;
    const directory = dirname(path);
    try {
      const owner = process.getuid?.();
      const parent = lstatSync(directory);
      if (!parent.isDirectory() || (owner !== undefined && parent.uid !== owner)) continue;
      const file = lstatSync(path, { throwIfNoEntry: false });
      if (file && (!file.isFile() || (owner !== undefined && file.uid !== owner))) continue;
      if (file) unlinkSync(path);
      rmdirSync(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}

function withDurableStore(metadata: DatabaseSync, durablePath: string, operation: () => void): void {
  metadata.prepare("ATTACH DATABASE ? AS durable").run(durablePath);
  try { operation(); }
  finally { metadata.exec("DETACH DATABASE durable"); }
}

// Only with Durable closed and app mutations gated. The rollback super-journal
// commits the attached SQLite files together.
function eraseAtomically(metadata: DatabaseSync, erase: () => void, compact: boolean): void {
  const wasWal = metadata.prepare("PRAGMA main.journal_mode").get()?.journal_mode === "wal";
  let transaction = false;
  try {
    assertRollbackJournal(metadata, "main");
    assertRollbackJournal(metadata, "durable");
    metadata.exec("BEGIN IMMEDIATE");
    transaction = true;
    erase();
    metadata.exec("COMMIT");
    transaction = false;

    if (compact) {
      // Reclaim previously freed pages as well as rows erased by secure_delete.
      // The committed removal remains valid if the filesystem cannot compact now.
      try { metadata.exec("VACUUM durable; VACUUM main"); } catch { /* optional page compaction */ }
    }
  } finally {
    if (transaction) metadata.exec("ROLLBACK");
    if (wasWal) metadata.exec("PRAGMA main.journal_mode = WAL");
  }
}

function eraseConversations(metadata: DatabaseSync, ids: string): void {
  metadata.exec(`
    CREATE TEMP TABLE pideck_removed_conversations (id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE pideck_removed_records (id INTEGER PRIMARY KEY);
  `);
  metadata.prepare("INSERT INTO temp.pideck_removed_conversations SELECT value FROM json_each(?)").run(ids);
  metadata.exec(`
    INSERT INTO temp.pideck_removed_records SELECT id FROM temp.pideck_removed_conversations
    UNION ALL SELECT id FROM durable.entries WHERE conversation_id IN temp.pideck_removed_conversations
    UNION ALL SELECT id FROM durable.tasks WHERE conversation_id IN temp.pideck_removed_conversations
    UNION ALL SELECT id FROM durable.submissions WHERE conversation_id IN temp.pideck_removed_conversations
    UNION ALL SELECT id FROM durable.documents WHERE
      (scope_kind = 'conversation' AND owner_id IN temp.pideck_removed_conversations)
      OR (scope_kind = 'task' AND owner_id IN (
        SELECT id FROM durable.tasks WHERE conversation_id IN temp.pideck_removed_conversations
      ));

    DELETE FROM durable.document_revisions WHERE document_id IN temp.pideck_removed_records;
    DELETE FROM durable.documents WHERE id IN temp.pideck_removed_records;
    DELETE FROM durable.submissions WHERE id IN temp.pideck_removed_records;
    DELETE FROM durable.tasks WHERE id IN temp.pideck_removed_records;
    DELETE FROM durable.entries WHERE id IN temp.pideck_removed_records;
    DELETE FROM durable.conversations WHERE id IN temp.pideck_removed_conversations;
    DELETE FROM durable.record_ids WHERE id IN temp.pideck_removed_records;
    DELETE FROM main.draft_images WHERE draftId IN
      (SELECT id FROM main.sessions WHERE conversationId IN temp.pideck_removed_conversations);
    DELETE FROM main.sessions WHERE conversationId IN temp.pideck_removed_conversations;
    DROP TABLE temp.pideck_removed_records;
    DROP TABLE temp.pideck_removed_conversations;
  `);
}

function unmappedCreationLeaves(metadata: DatabaseSync): ConversationId[] {
  const rows = metadata.prepare(`
    SELECT candidate.id
    FROM durable.conversations AS candidate
    WHERE candidate.id > ?
      AND candidate.owner_conversation_id IS NULL
      AND candidate.owner_task_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM main.sessions AS session WHERE session.conversationId = candidate.id)
      AND NOT EXISTS (SELECT 1 FROM durable.entries AS entry WHERE entry.conversation_id = candidate.id)
      AND NOT EXISTS (SELECT 1 FROM durable.tasks AS task WHERE task.conversation_id = candidate.id)
      AND NOT EXISTS (SELECT 1 FROM durable.submissions AS submission WHERE submission.conversation_id = candidate.id)
      AND NOT EXISTS (
        SELECT 1 FROM durable.conversations AS child
        WHERE child.owner_conversation_id = candidate.id
          OR json_extract(child.record, '$.parent.conversationId') = candidate.id
      )
  `).all(ROOT_CONVERSATION_ID);
  return rows.map(row => row.id as ConversationId);
}

/** Recover a host interruption between native create/fork and app session mapping. */
export function reapUnmappedConversations(metadata: DatabaseSync, durablePath: string): void {
  if (!existsSync(durablePath)) return;
  withDurableStore(metadata, durablePath, () => {
    // Let the native adapter initialize or migrate an unfamiliar store.
    if (!hasPurgeSchema(metadata, "durable") || !unmappedCreationLeaves(metadata).length) return;
    eraseAtomically(metadata, () => {
      const leaves = unmappedCreationLeaves(metadata);
      if (leaves.length) eraseConversations(metadata, JSON.stringify(leaves));
    }, false);
  });
}

export function purgeConversations(
  metadata: DatabaseSync,
  durablePath: string,
  projectId: string,
  roots: readonly ConversationId[],
  removeProject: boolean,
  expected: readonly ConversationId[],
  legacySpills: readonly string[] = [],
): void {
  withDurableStore(metadata, durablePath, () => {
    checkSchema(metadata, "durable");
    eraseAtomically(metadata, () => {
      if (!metadata.prepare("SELECT 1 FROM main.projects WHERE id = ?").get(projectId)) {
        throw new Error("Project not found.");
      }
      const projectSessions = metadata.prepare("SELECT conversationId FROM main.sessions WHERE projectId = ?")
        .all(projectId).map(row => row.conversationId as ConversationId);
      if (roots.some(id => !projectSessions.includes(id)) || (removeProject && !sameIds(roots, projectSessions))) {
        throw new Error("The project's sessions changed. Review what will be removed and try again.");
      }
      const actual = closure(metadata, "durable", roots);
      if (roots.some(id => !actual.includes(id)) || !sameIds(expected, actual)) {
        throw new Error("The conversation's forks changed. Review what will be removed and try again.");
      }
      const ids = JSON.stringify(actual);
      if (metadata.prepare(`
        SELECT 1 FROM main.sessions
        WHERE projectId <> ? AND conversationId IN (SELECT value FROM json_each(?)) LIMIT 1
      `).get(projectId, ids)) {
        throw new Error("Removal would affect sessions in another project.");
      }

      if (legacySpills.length) {
        const enqueue = metadata.prepare("INSERT OR IGNORE INTO main.tool_output_cleanup (path) VALUES (?)");
        for (const path of legacySpills) if (legacySpillPath(path)) enqueue.run(path);
      }
      eraseConversations(metadata, ids);
      if (removeProject) metadata.prepare("DELETE FROM main.projects WHERE id = ?").run(projectId);
    }, true);
  });
}
