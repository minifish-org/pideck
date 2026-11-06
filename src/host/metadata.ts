import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Project, Session } from "../shared/api.js";

type DirectoryIdentity = { directory: string; device: string; inode: string };
type ProjectRow = DirectoryIdentity & { id: string; name: string; trusted: number; createdAt: number };
type SessionRow = Session & { conversationId: ConversationId };

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
    trusted: row.trusted === 1,
    createdAt: row.createdAt,
  };
}

function presentSession(row: SessionRow): Session {
  const { conversationId: _conversationId, ...session } = row;
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
          updatedAt INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS project_sessions ON sessions(projectId, updatedAt DESC);

        CREATE TABLE IF NOT EXISTS model_catalogs (
          provider TEXT PRIMARY KEY,
          catalog TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS installation (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          deviceId TEXT NOT NULL
        ) STRICT;
      `);
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
    const row = this.db.prepare(`
      INSERT INTO projects (id, directory, name, device, inode, createdAt) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(directory) DO UPDATE SET
        device = excluded.device,
        inode = excluded.inode,
        trusted = CASE
          WHEN projects.device = excluded.device AND projects.inode = excluded.inode THEN projects.trusted
          ELSE 0
        END
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

  trustProject(id: string): Project {
    const row = this.project(id);
    if (!sameDirectory(row, inspectDirectory(row.directory))) {
      throw new Error("The project folder changed. Open it again to review trust.");
    }
    this.db.prepare("UPDATE projects SET trusted = 1 WHERE id = ?").run(id);
    return presentProject({ ...row, trusted: 1 });
  }

  requireTrustedProject(id: string): Project {
    const row = this.project(id);
    if (!row.trusted) throw new Error("Trust this project before running tools or opening a terminal.");
    if (!sameDirectory(row, inspectDirectory(row.directory))) {
      throw new Error("The project folder changed. Open it again to review trust.");
    }
    return presentProject(row);
  }

  listSessions(projectId: string): Session[] {
    this.project(projectId);
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE projectId = ? ORDER BY updatedAt DESC, rowid DESC",
    ).all(projectId) as SessionRow[];
    return rows.map(presentSession);
  }

  createSession(projectId: string, conversationId: ConversationId, title: string): Session {
    const now = Date.now();
    const session = { id: randomUUID(), projectId, title, createdAt: now, updatedAt: now };
    this.db.prepare(
      "INSERT INTO sessions (id, projectId, conversationId, title, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(session.id, projectId, conversationId, title, session.createdAt, session.updatedAt);
    return session;
  }

  touchSession(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET updatedAt = ? WHERE id = ?").run(Date.now(), sessionId);
  }

  session(projectId: string, sessionId: string): SessionRow {
    const row = this.db.prepare(
      "SELECT * FROM sessions WHERE projectId = ? AND id = ?",
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
