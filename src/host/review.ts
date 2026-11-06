import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ReviewFile, ReviewPatch } from "../shared/api.js";
import { shellEnvironment } from "./shell-env.js";

const exec = promisify(execFile);
const patchLimit = 512 * 1024;
const diffOptions = [
  "--no-ext-diff", "--no-textconv", "--no-color", "--word-diff=none", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/",
];

async function git(cwd: string, args: string[], accept: number[] = [], maxBuffer = 2 * 1024 * 1024) {
  try {
    const child = exec("git", [
      "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false",
      ...args,
    ], {
      cwd, encoding: "utf8", maxBuffer, timeout: 15_000, windowsHide: true,
      env: { ...shellEnvironment(), LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    child.child.stdin?.end();
    const result = await child;
    return result.stdout;
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (accept.includes(Number(error.code)) && !error.killed) return error.stdout ?? "";
    if (error.code === "ENOENT") throw new Error("Git or the project directory is unavailable.");
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
    if (error.killed) throw new Error("Git took too long to read the project's changes.");
    if (error.stderr?.startsWith("fatal: not a git repository")) return "";
    throw new Error("Git could not read the project's changes.");
  }
}

export async function listChanges(cwd: string): Promise<ReviewFile[]> {
  const prefixResult = await git(cwd, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
  if (!prefixResult.startsWith("true\n")) return [];
  const prefix = prefixResult.slice(5, -1);
  let raw: string;
  try {
    raw = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--renames", "--", "."]);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error("There are too many changed paths to list in the review panel.");
    }
    throw cause;
  }
  const entries = raw.split("\0");
  const files = new Map<string, ReviewFile>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const name = entry.slice(3);
    const oldName = /[RC]/.test(status) ? entries[++index] : undefined;
    if (!name.startsWith(prefix)) continue;
    const path = name.slice(prefix.length);
    const oldPath = oldName?.startsWith(prefix) ? oldName.slice(prefix.length) : undefined;
    if (!path) continue;
    const previous = files.get(path);
    // A staged deletion followed by recreating the path yields two status rows.
    // Keep both transitions instead of silently replacing the staged deletion.
    if (previous && status === "??") files.set(path, { ...previous, status: `${previous.status[0]}?` });
    else files.set(path, { path, status, ...(oldPath ? { oldPath } : {}) });
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export async function readPatch(cwd: string, path: string): Promise<ReviewPatch> {
  if (!isProjectPath(cwd, path)) throw new Error("The review path must be inside the project.");
  const file = (await listChanges(cwd)).find(candidate => candidate.path === path);
  if (!file) return { patch: null, reason: "This file is no longer listed as changed." };

  let patch: string;
  try {
    if (file.status.endsWith("?")) {
      const fullPath = resolve(cwd, path);
      const parent = await realpath(dirname(fullPath));
      const project = await realpath(cwd);
      if (parent !== project && !isProjectPath(project, relative(project, parent))) {
        return { patch: null, reason: "This path resolves outside the project." };
      }
      const stat = await lstat(fullPath);
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        return { patch: null, reason: "This path cannot be displayed as a file diff." };
      }
      if (stat.size > patchLimit) return largePatch();
      patch = await git(cwd, ["diff", "--no-index", ...diffOptions, "--", "/dev/null", `./${path}`], [1], patchLimit);
      if (file.status !== "??") {
        const staged = await git(cwd, ["diff", "--cached", "--relative", ...diffOptions, "--", path], [], patchLimit);
        patch = staged + patch;
      }
    } else {
      const head = (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], [1])).trim();
      const base = head || (await git(cwd, ["hash-object", "-t", "tree", "--stdin"])).trim();
      const paths = file.oldPath ? [file.oldPath, path] : [path];
      const diff = ["diff", "--relative", "--find-renames", "--ignore-submodules=dirty", ...diffOptions];
      patch = await git(cwd, [...diff, base, "--", ...paths], [], patchLimit);
      if (!patch) {
        const staged = await git(cwd, [...diff, "--cached", "--", ...paths], [], patchLimit);
        const unstaged = await git(cwd, [...diff, "--", ...paths], [], patchLimit);
        patch = staged + unstaged;
      }
    }
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return largePatch();
    if (code === "ENOENT") return { patch: null, reason: "This file was removed while the review was loading." };
    throw cause;
  }

  if (Buffer.byteLength(patch) > patchLimit) return largePatch();
  if (!patch) return { patch: null, reason: "There are no text changes to display for this file." };
  if (!/^@@ /m.test(patch) && /^Binary files .* differ$/m.test(patch)) {
    return { patch: null, reason: "This binary file has changed." };
  }
  return { patch };
}

function isProjectPath(cwd: string, path: string) {
  if (!path || path.includes("\0") || isAbsolute(path)) return false;
  if (path.split(process.platform === "win32" ? /[\\/]/ : "/").some(part => part === "..")) return false;
  const scoped = relative(cwd, resolve(cwd, path));
  return Boolean(scoped) && !isAbsolute(scoped) && scoped !== ".." && !scoped.startsWith(`..${sep}`);
}

function largePatch(): ReviewPatch {
  return { patch: null, reason: "This diff exceeds the review panel's 512 KB limit." };
}
