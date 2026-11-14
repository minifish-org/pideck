import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { projectMessageLink, type ProjectLink } from "../shared/message-links.js";
import type { ImageInput, ReviewFileContents } from "../shared/api.js";

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

async function readProjectBytes(directory: string, relativePath: string, limit: number, signal?: AbortSignal) {
  const target = await projectFile(directory, relativePath, signal);
  // Open the resolved regular file without following a replacement leaf symlink.
  // Nonblocking mode also prevents a replaced FIFO from hanging the trusted host.
  const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    signal?.throwIfAborted();
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("This link does not refer to a project file.");
    if (before.size > limit) return { path: target.path, bytes: null };
    const buffer = Buffer.alloc(limit + 1);
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
    signal?.throwIfAborted();
    return { path: target.path, bytes: length > limit ? null : buffer.subarray(0, length) };
  } finally {
    await handle.close();
  }
}

export async function readMessageFile(directory: string, relativePath: string, signal?: AbortSignal): Promise<ReviewFileContents> {
  const { path, bytes } = await readProjectBytes(directory, relativePath, fileLimit, signal);
  if (!bytes) return { path, contents: null, reason: "This file exceeds the 1 MB preview limit." };
  let contents: string;
  try { contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return { path, contents: null, reason: "This file is not UTF-8 text and cannot be previewed." }; }
  if (contents.includes("\0") || (contents.match(/[\u0001-\u0008\u000b\u000e-\u001f]/g)?.length ?? 0) > contents.length / 100) {
    return { path, contents: null, reason: "This binary file cannot be previewed." };
  }
  return { path, contents };
}

export async function readMessageImage(directory: string, relativePath: string, signal?: AbortSignal): Promise<ImageInput> {
  const { bytes } = await readProjectBytes(directory, relativePath, 12_000_000, signal);
  if (!bytes) throw new Error("This image exceeds the 12 MB preview limit.");
  // Sniff raster formats, not extensions. In particular, never load SVG/HTML
  // from an untrusted path into the privileged application's document.
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
    : /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6)) ? "image/gif"
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
  if (!mimeType) throw new Error("Only PNG, JPEG, WebP and GIF images can be previewed.");
  return { mimeType, data: bytes.toString("base64") };
}
