import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ReviewFile, ReviewPatch } from "../shared/api.js";
import { shellEnvironment } from "./shell-env.js";

const exec = promisify(execFile);
const patchLimit = 512 * 1024;
const diffOptions = [
  "--no-ext-diff", "--no-textconv", "--no-color", "--word-diff=none", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/",
];

async function git(cwd: string, args: string[], signal?: AbortSignal, accept: number[] = [], maxBuffer = 2 * 1024 * 1024) {
  signal?.throwIfAborted();
  try {
    const child = exec("git", [
      "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false",
      ...args,
    ], {
      cwd, encoding: "utf8", maxBuffer, timeout: 15_000, windowsHide: true, signal,
      env: { ...shellEnvironment(), LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    child.child.stdin?.end();
    const result = await child;
    signal?.throwIfAborted();
    return result.stdout;
  } catch (cause) {
    signal?.throwIfAborted();
    const error = cause as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (accept.includes(Number(error.code)) && !error.killed) return error.stdout ?? "";
    if (error.code === "ENOENT") throw new Error("Git or the project directory is unavailable.");
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
    if (error.killed) throw new Error("Git took too long to read the project's changes.");
    if (error.stderr?.startsWith("fatal: not a git repository")) return "";
    throw new Error("Git could not read the project's changes.");
  }
}

export async function watchChanges(cwd: string, signal: AbortSignal, onChange: () => void, onError: () => void) {
  const metadataPaths = new Set([join(cwd, ".git")]);
  let pending: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener("abort", () => clearTimeout(pending), { once: true });

  const notify = () => {
    if (pending || signal.aborted) return;
    pending = setTimeout(() => {
      pending = undefined;
      onChange();
    }, 180);
  };
  const attach = (directory: string, recursive: boolean, accepts: (name: string) => boolean) => {
    signal.throwIfAborted();
    const watcher = watch(directory, { recursive, signal }, (_, name) => {
      if (name === null || accepts(name)) notify();
    });
    watcher.on("error", onError);
  };
  attach(cwd, true, name => {
    const path = join(cwd, name);
    for (const directory of metadataPaths) {
      const nested = relative(directory, path);
      if (nested && !isAbsolute(nested) && nested !== ".." && !nested.startsWith(`..${sep}`)) {
        return reviewMetadata(nested);
      }
    }
    return true;
  });

  const paths = await Promise.all(["--git-dir", "--git-common-dir"].map(option =>
    git(cwd, ["rev-parse", "--path-format=absolute", option], signal).then(path => path.replace(/\r?\n$/, ""))));
  signal.throwIfAborted();
  for (const directory of new Set(paths.filter(Boolean))) {
    if (directory === cwd) continue;
    if (isProjectPath(cwd, relative(cwd, directory))) {
      metadataPaths.add(directory);
      continue;
    }
    // Subdirectory projects and linked worktrees can keep Git state outside the workspace.
    attach(directory, false, reviewMetadata);
    for (const part of ["refs", "info"]) {
      try {
        attach(join(directory, part), true, name => !name.endsWith(".lock"));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
  }
}

function reviewMetadata(name: string): boolean {
  if (name.endsWith(".lock")) return false;
  const [top] = name.split(sep, 1);
  return ["HEAD", "index", "packed-refs", "config", "config.worktree", "refs", "info"].includes(top);
}

export async function listChanges(cwd: string, signal?: AbortSignal): Promise<ReviewFile[]> {
  const prefixResult = await git(cwd, ["rev-parse", "--is-inside-work-tree", "--show-prefix"], signal);
  if (!prefixResult.startsWith("true\n")) return [];
  const prefix = prefixResult.slice(5, -1);
  let raw: string;
  try {
    raw = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--renames", "--", "."], signal);
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

export async function readPatch(cwd: string, path: string, signal?: AbortSignal): Promise<ReviewPatch> {
  signal?.throwIfAborted();
  if (!isProjectPath(cwd, path)) throw new Error("The review path must be inside the project.");
  const file = (await listChanges(cwd, signal)).find(candidate => candidate.path === path);
  if (!file) return { patch: null, reason: "This file is no longer listed as changed." };

  let patch: string;
  try {
    if (file.status.endsWith("?")) {
      const fullPath = resolve(cwd, path);
      const parent = await realpath(dirname(fullPath));
      const project = await realpath(cwd);
      signal?.throwIfAborted();
      if (parent !== project && !isProjectPath(project, relative(project, parent))) {
        return { patch: null, reason: "This path resolves outside the project." };
      }
      const stat = await lstat(fullPath);
      signal?.throwIfAborted();
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        return { patch: null, reason: "This path cannot be displayed as a file diff." };
      }
      if (stat.size > patchLimit) return largePatch();
      patch = await git(cwd, ["diff", "--no-index", ...diffOptions, "--", "/dev/null", `./${path}`], signal, [1], patchLimit);
      if (file.status !== "??") {
        const staged = await git(cwd, ["diff", "--cached", "--relative", ...diffOptions, "--", path], signal, [], patchLimit);
        patch = staged + patch;
      }
    } else {
      const head = (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], signal, [1])).trim();
      const base = head || (await git(cwd, ["hash-object", "-t", "tree", "--stdin"], signal)).trim();
      const paths = file.oldPath ? [file.oldPath, path] : [path];
      const diff = ["diff", "--relative", "--find-renames", "--ignore-submodules=dirty", ...diffOptions];
      patch = await git(cwd, [...diff, base, "--", ...paths], signal, [], patchLimit);
      if (!patch) {
        const staged = await git(cwd, [...diff, "--cached", "--", ...paths], signal, [], patchLimit);
        const unstaged = await git(cwd, [...diff, "--", ...paths], signal, [], patchLimit);
        patch = staged + unstaged;
      }
    }
  } catch (cause) {
    signal?.throwIfAborted();
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
