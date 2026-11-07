import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { projectMessageLink, type ProjectLink } from "../shared/message-links.js";
import type { ReviewFileContents } from "../shared/api.js";

const fileLimit = 1024 * 1024;

function scopedPath(root: string, path: string) {
  const scoped = relative(root, path);
  if (!scoped || isAbsolute(scoped) || scoped === ".." || scoped.startsWith(`..${sep}`)) {
    throw new Error("This linked file resolves outside the selected project.");
  }
  return scoped.split(sep).join("/");
}

async function projectFile(directory: string, relativePath: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(relativePath) || relativePath.split("/").includes("..")) {
    throw new Error("This link is not a file inside the selected project.");
  }
  const root = await realpath(directory);
  const requested = resolve(root, relativePath);
  scopedPath(root, requested);
  const absolute = await realpath(requested).catch(() => {
    throw new Error("This linked file is no longer available in the project.");
  });
  signal?.throwIfAborted();
  const path = scopedPath(root, absolute);
  if (!(await stat(absolute)).isFile()) throw new Error("This link does not refer to a project file.");
  signal?.throwIfAborted();
  return { root, requested, absolute, path };
}

export async function resolveMessageFile(directory: string, href: string, signal?: AbortSignal): Promise<ProjectLink> {
  signal?.throwIfAborted();
  const target = projectMessageLink(href, directory);
  if (!target) throw new Error("This link is not a file inside the selected project.");
  const { path } = await projectFile(directory, target.path, signal);
  return { path, ...(target.line !== undefined ? { line: target.line } : {}) };
}

export async function readMessageFile(directory: string, relativePath: string, signal?: AbortSignal): Promise<ReviewFileContents> {
  const target = await projectFile(directory, relativePath, signal);
  // Open the resolved regular file without following a replacement leaf symlink.
  // Nonblocking mode also prevents a replaced FIFO from hanging the trusted host.
  const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    signal?.throwIfAborted();
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("This link does not refer to a project file.");
    if (before.size > fileLimit) return { path: target.path, contents: null, reason: "This file exceeds the 1 MB preview limit." };
    const buffer = Buffer.alloc(fileLimit + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, length, Math.min(64 * 1024, buffer.length - length), length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    signal?.throwIfAborted();
    const current = await realpath(target.requested);
    scopedPath(target.root, current);
    const after = await stat(current);
    if (current !== target.absolute || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("This file changed while opening. Try again.");
    }
    if (length > fileLimit) return { path: target.path, contents: null, reason: "This file exceeds the 1 MB preview limit." };
    const bytes = buffer.subarray(0, length);
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { path: target.path, contents: null, reason: "This file is not UTF-8 text and cannot be previewed." };
    }
    if (contents.includes("\0") || (contents.match(/[\u0001-\u0008\u000b\u000e-\u001f]/g)?.length ?? 0) > contents.length / 100) {
      return { path: target.path, contents: null, reason: "This binary file cannot be previewed." };
    }
    signal?.throwIfAborted();
    return { path: target.path, contents };
  } finally {
    await handle.close();
  }
}
