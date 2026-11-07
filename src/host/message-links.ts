import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { projectMessageLink, type ProjectLink } from "../shared/message-links.js";

export async function resolveMessageFile(directory: string, href: string, signal?: AbortSignal): Promise<ProjectLink> {
  signal?.throwIfAborted();
  const target = projectMessageLink(href, directory);
  if (!target) throw new Error("This link is not a file inside the selected project.");
  const root = await realpath(directory);
  const path = await realpath(resolve(root, target.path)).catch(() => {
    throw new Error("This linked file is no longer available in the project.");
  });
  signal?.throwIfAborted();
  const scoped = relative(root, path);
  if (!scoped || isAbsolute(scoped) || scoped === ".." || scoped.startsWith(`..${sep}`)) {
    throw new Error("This linked file resolves outside the selected project.");
  }
  if (!(await stat(path)).isFile()) throw new Error("This link does not refer to a project file.");
  signal?.throwIfAborted();
  return { path: scoped.split(sep).join("/"), ...(target.line !== undefined ? { line: target.line } : {}) };
}
