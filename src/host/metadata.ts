import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Project, Selection, Session, SessionActivity } from "../shared/api.js";
import { purgeConversations, reapUnmappedConversations } from "./purge.js";

type DirectoryIdentity = { directory: string; device: string; inode: string };
type ProjectRow = DirectoryIdentity & Project;
type SessionRow = Session & { conversationId: ConversationId; autoTitlePending: 0 | 1; startPending: 0 | 1 };
export type StoredSessionActivity = Omit<SessionActivity, keyof Selection> & { conversationId: ConversationId };

function inspectDirectory(path: string): DirectoryIdentity {
  let directory: string;
  try {
    directory = realpathSync(path);
    const info = statSync(directory, { bigint: true });
    if (info.isDirectory()) {
      return { directory, device: info.dev.toString(), inode: info.ino.toString() };
    }
  } catch {
    // The same user-facing error covers a removed or inaccessible directory.
  }
  throw new Error("The project directory is unavailable.");
}

function sameDirectory(row: DirectoryIdentity, current: DirectoryIdentity): boolean {
  return row.directory === current.directory && row.device === current.device && row.inode === current.inode;
}

function presentProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    directory: row.directory,
    createdAt: row.createdAt,
  };
}

function presentSession(row: SessionRow): Session {
  const { conversationId: _conversationId, autoTitlePending: _autoTitlePending, startPending: _startPending, ...session } = row;
  return session;
}

export class Metadata {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA secure_delete = ON;

        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          directory TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          device TEXT NOT NULL,
          inode TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          trusted INTEGER NOT NULL DEFAULT 0 CHECK (trusted IN (0, 1))
        ) STRICT;

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL REFERENCES projects(id),
          conversationId INTEGER NOT NULL UNIQUE,
          title TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          autoTitlePending INTEGER NOT NULL DEFAULT 0 CHECK (autoTitlePending IN (0, 1)),
          startPending INTEGER NOT NULL DEFAULT 0 CHECK (startPending IN (0, 1))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS project_sessions ON sessions(projectId, updatedAt DESC);

        CREATE TABLE IF NOT EXISTS session_activity (
          conversationId INTEGER PRIMARY KEY REFERENCES sessions(conversationId) ON DELETE CASCADE,
          taskId INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('running', 'finished', 'attention')),
          settled INTEGER NOT NULL CHECK (settled IN (0, 1)),
          resultEntryId INTEGER
        ) STRICT;

        CREATE TABLE IF NOT EXISTS model_catalogs (
          provider TEXT PRIMARY KEY,
          catalog TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS installation (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          deviceId TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS tool_output_cleanup (path TEXT PRIMARY KEY) STRICT;
      `);
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'autoTitlePending'").get()) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN autoTitlePending INTEGER NOT NULL DEFAULT 0 CHECK (autoTitlePending IN (0, 1))");
      }
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'startPending'").get()) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN startPending INTEGER NOT NULL DEFAULT 0 CHECK (startPending IN (0, 1))");
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  listProjects(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY rowid DESC").all() as ProjectRow[];
    return rows.map(presentProject);
  }

  addProject(path: string): Project {
    const current = inspectDirectory(path);
    // Keep the legacy column readable by older builds. Registration and
    // directory identity are the authorization in the current build.
    const row = this.db.prepare(`
      INSERT INTO projects (id, directory, name, device, inode, createdAt, trusted) VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(directory) DO UPDATE SET
        device = excluded.device,
        inode = excluded.inode,
        trusted = 1
      RETURNING *
    `).get(randomUUID(), current.directory, basename(current.directory) || current.directory,
      current.device, current.inode, Date.now());
    return presentProject(row as ProjectRow);
  }

  private project(id: string): ProjectRow {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    if (!row) throw new Error("Project not found.");
    return row;
  }

  getProject(id: string): Project {
    return presentProject(this.project(id));
  }

  requireProject(id: string): Project {
    const row = this.project(id);
    if (!sameDirectory(row, inspectDirectory(row.directory))) {
      throw new Error("The project folder changed. Open it again to continue.");
    }
    return presentProject(row);
  }

  listSessions(projectId: string): Session[] {
    return this.sessionRows(projectId).filter(row => !row.startPending).map(presentSession);
  }

  sessionRows(projectId: string): SessionRow[] {
    this.project(projectId);
    return this.db.prepare(
      "SELECT * FROM sessions WHERE projectId = ? ORDER BY updatedAt DESC, rowid DESC",
    ).all(projectId) as SessionRow[];
  }

  createSession(projectId: string, conversationId: ConversationId, title: string, autoTitlePending = false, startId?: string): Session {
    const now = Date.now();
    const session = { id: startId ?? randomUUID(), projectId, title, createdAt: now, updatedAt: now };
    this.db.prepare(
      "INSERT INTO sessions (id, projectId, conversationId, title, createdAt, updatedAt, autoTitlePending, startPending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(session.id, projectId, conversationId, title, session.createdAt, session.updatedAt, Number(autoTitlePending), Number(startId !== undefined));
    return session;
  }

  pendingStarts(): Pick<SessionRow, "id" | "conversationId">[] {
    return this.db.prepare("SELECT id, conversationId FROM sessions WHERE startPending = 1").all() as
      Pick<SessionRow, "id" | "conversationId">[];
  }

  findSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  finishSessionStart(id: string): Session {
    const row = this.db.prepare("UPDATE sessions SET startPending = 0 WHERE id = ? RETURNING *").get(id) as SessionRow;
    return presentSession(row);
  }

  discardSessionStart(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ? AND startPending = 1").run(id);
  }

  touchSession(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET updatedAt = ? WHERE id = ?").run(Date.now(), sessionId);
  }

  sessionsAwaitingTitle(): Pick<SessionRow, "id" | "conversationId">[] {
    return this.db.prepare("SELECT id, conversationId FROM sessions WHERE autoTitlePending = 1").all() as
      Pick<SessionRow, "id" | "conversationId">[];
  }

  setAutomaticTitle(sessionId: string, title: string): void {
    this.db.prepare("UPDATE sessions SET title = ?, autoTitlePending = 0 WHERE id = ? AND autoTitlePending = 1")
      .run(title, sessionId);
  }

  renameSession(projectId: string, sessionId: string, title: string): Session {
    const row = this.db.prepare(
      "UPDATE sessions SET title = ?, autoTitlePending = 0 WHERE projectId = ? AND id = ? AND startPending = 0 RETURNING *",
    ).get(title, projectId, sessionId) as SessionRow | undefined;
    if (!row) throw new Error("Session not found in this project.");
    return presentSession(row);
  }

  session(projectId: string, sessionId: string): SessionRow {
    const row = this.db.prepare(
      "SELECT * FROM sessions WHERE projectId = ? AND id = ? AND startPending = 0",
    ).get(projectId, sessionId) as SessionRow | undefined;
    if (!row) throw new Error("Session not found in this project.");
    return row;
  }

  projectOf(conversationId: ConversationId): string {
    const row = this.db.prepare(
      "SELECT projectId FROM sessions WHERE conversationId = ?",
    ).get(conversationId);
    if (!row) throw new Error("Conversation is not attached to a project.");
    return row.projectId as string;
  }

  sessionSelection(conversationId: ConversationId): { projectId: string; sessionId: string } | undefined {
    return this.db.prepare("SELECT projectId, id AS sessionId FROM sessions WHERE conversationId = ?")
      .get(conversationId) as { projectId: string; sessionId: string } | undefined;
  }

  hasConversation(conversationId: number): boolean {
    return this.db.prepare("SELECT 1 FROM sessions WHERE conversationId = ?").get(conversationId) !== undefined;
  }

  sessionActivities(): StoredSessionActivity[] {
    const rows = this.db.prepare("SELECT * FROM session_activity").all();
    return rows.map(row => ({
      conversationId: row.conversationId as ConversationId,
      taskId: row.taskId as number,
      state: row.state as SessionActivity["state"],
      settled: Boolean(row.settled),
      ...(row.resultEntryId === null ? {} : { resultEntryId: row.resultEntryId as number }),
    }));
  }

  saveSessionActivity(conversationId: ConversationId, activity: Omit<StoredSessionActivity, "conversationId">): void {
    // An asynchronous Durable receipt must never recreate a removed session.
    this.db.prepare(`
      INSERT INTO session_activity (conversationId, taskId, state, settled, resultEntryId)
      SELECT conversationId, ?, ?, ?, ? FROM sessions WHERE conversationId = ?
      ON CONFLICT(conversationId) DO UPDATE SET
        taskId = excluded.taskId, state = excluded.state,
        settled = excluded.settled, resultEntryId = excluded.resultEntryId
    `).run(activity.taskId, activity.state, Number(activity.settled), activity.resultEntryId ?? null, conversationId);
  }

  clearSessionActivity(conversationId: ConversationId): void {
    this.db.prepare("DELETE FROM session_activity WHERE conversationId = ?").run(conversationId);
  }

  removeEmptyProject(projectId: string): void {
    const result = this.db.prepare(`
      DELETE FROM projects WHERE id = ? AND NOT EXISTS (SELECT 1 FROM sessions WHERE projectId = ?)
    `).run(projectId, projectId);
    if (result.changes !== 1) throw new Error("The workspace changed. Review the removal again.");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  purge(durablePath: string, projectId: string, roots: ConversationId[], removeProject: boolean, expected: ConversationId[], legacySpills: string[]) {
    purgeConversations(this.db, durablePath, projectId, roots, removeProject, expected, legacySpills);
  }

  reapUnmapped(durablePath: string) {
    reapUnmappedConversations(this.db, durablePath);
  }

  outputCleanupPaths(): string[] {
    return this.db.prepare("SELECT path FROM tool_output_cleanup").all().map(row => row.path as string);
  }

  finishOutputCleanup(paths: string[]): void {
    if (!paths.length) return;
    this.db.prepare("DELETE FROM tool_output_cleanup WHERE path IN (SELECT value FROM json_each(?))")
      .run(JSON.stringify(paths));
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  readonly modelsStore: ModelsStore = {
    read: async (provider, options) => {
      options?.signal?.throwIfAborted();
      const row = this.db.prepare("SELECT catalog FROM model_catalogs WHERE provider = ?").get(provider);
      return row && JSON.parse(row.catalog as string) as ModelsStoreEntry;
    },
    write: async (provider, catalog, options) => {
      options?.signal?.throwIfAborted();
      this.db.prepare(`
        INSERT INTO model_catalogs (provider, catalog) VALUES (?, ?)
        ON CONFLICT(provider) DO UPDATE SET catalog = excluded.catalog
      `).run(provider, JSON.stringify(catalog));
    },
    delete: async (provider, options) => {
      options?.signal?.throwIfAborted();
      this.db.prepare("DELETE FROM model_catalogs WHERE provider = ?").run(provider);
    },
  };

  deviceId(): string {
    const query = this.db.prepare("SELECT deviceId FROM installation WHERE singleton = 1");
    const existing = query.get();
    if (existing) return existing.deviceId as string;
    const deviceId = randomUUID();
    this.db.prepare("INSERT INTO installation (singleton, deviceId) VALUES (1, ?)").run(deviceId);
    return deviceId;
  }

  close(): void {
    this.db.close();
  }
}
