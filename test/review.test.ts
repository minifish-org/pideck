import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { listChanges, readPatch, watchChanges } from "../src/host/review.js";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", [
    "-c", "user.email=pideck-test@example.invalid", "-c", "user.name=Pideck Test", "-c", "commit.gpgSign=false", ...args,
  ], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
}

test("lists and displays tracked, renamed, and untracked files inside the selected Git folder", async t => {
  const root = await mkdtemp(join(tmpdir(), "pideck-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "feature area");
  await mkdir(cwd);
  git(root, "init", "-q");
  await writeFile(join(cwd, "old name.ts"), "const value = 1;\n");
  await writeFile(join(cwd, "tracked.ts"), "const tracked = true;\n");
  await writeFile(join(root, "outside.txt"), "outside\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "start");
  await rename(join(cwd, "old name.ts"), join(cwd, "new name.ts"));
  git(cwd, "add", "-A", ".");
  await writeFile(join(cwd, "tracked.ts"), "const tracked = false;\n");
  await writeFile(join(cwd, "词 file.ts"), "const created = 3;\n");
  await writeFile(join(cwd, "asset.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(root, "outside.txt"), "change outside project\n");

  const changes = new Map((await listChanges(cwd)).map(file => [file.path, file]));
  assert.equal(changes.size, 4);
  assert.deepEqual(changes.get("new name.ts"), { path: "new name.ts", oldPath: "old name.ts", status: "R " });
  assert.equal(changes.get("tracked.ts")?.status, " M");
  assert.equal(changes.get("词 file.ts")?.status, "??");
  assert.match((await readPatch(cwd, "new name.ts")).patch ?? "", /similarity index 100%/);
  assert.match((await readPatch(cwd, "tracked.ts")).patch ?? "", /\+const tracked = false;/);
  assert.match((await readPatch(cwd, "词 file.ts")).patch ?? "", /\+const created = 3;/);
  assert.deepEqual(await readPatch(cwd, "asset.bin"), { patch: null, reason: "This binary file has changed." });
  await assert.rejects(readPatch(cwd, "../outside.txt"), /inside the project/);
  await assert.rejects(readPatch(cwd, join(root, "outside.txt")), /inside the project/);
});

test("reads the working tree of an unborn branch and preserves staged changes reverted on disk", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pideck-review-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  assert.deepEqual(await listChanges(cwd), []);
  git(cwd, "init", "-q");
  const file = join(cwd, "file.txt");
  await writeFile(file, "first\n");
  git(cwd, "add", ".");
  await writeFile(file, "second\n");
  assert.match((await readPatch(cwd, "file.txt")).patch ?? "", /\+second/);
  git(cwd, "commit", "-qm", "start");
  await writeFile(file, "third\n");
  git(cwd, "add", ".");
  await writeFile(file, "first\n");
  const patch = (await readPatch(cwd, "file.txt")).patch ?? "";
  assert.match(patch, /-first\n\+third/);
  assert.match(patch, /-third\n\+first/);
});

test("shows both sides when a staged removal is recreated as an untracked file", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pideck-review-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q");
  await writeFile(join(cwd, "a.txt"), "old\n");
  git(cwd, "add", "a.txt");
  git(cwd, "commit", "-qm", "start");
  git(cwd, "rm", "-q", "a.txt");
  await writeFile(join(cwd, "a.txt"), "new\n");

  assert.deepEqual(await listChanges(cwd), [{ path: "a.txt", status: "D?" }]);
  const patch = (await readPatch(cwd, "a.txt")).patch ?? "";
  assert.match(patch, /\n-old\n/);
  assert.match(patch, /\n\+new\n/);
});

test("an aborted project review stops in-flight Git work and rejects further reads", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pideck-review-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q");
  await writeFile(join(cwd, "changed.txt"), "changed\n");
  const review = new AbortController();
  const inFlight = listChanges(cwd, review.signal);
  review.abort(new Error("Project removed."));
  await assert.rejects(inFlight, /Project removed/);
  await assert.rejects(readPatch(cwd, "changed.txt", review.signal), /Project removed/);
  assert.match((await readPatch(cwd, "changed.txt")).patch ?? "", /\+changed/);
});

test("review watch sees workspace edits and Git index changes outside a selected subdirectory", { timeout: 8_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pideck-review-watch-"));
  const watch = new AbortController();
  t.after(async () => {
    watch.abort();
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, "src");
  const file = join(cwd, "tracked.ts");
  await mkdir(cwd);
  await writeFile(file, "before\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "start");

  let changed = Promise.withResolvers<void>();
  let events = 0;
  let waitingFor = "external Git metadata watch readiness";
  t.after(() => {
    if (t.signal.aborted) t.diagnostic(`Waiting for ${waitingFor}; received ${events} review notifications.`);
  });
  await watchChanges(cwd, watch.signal, () => { events++; changed.resolve(); },
    () => changed.reject(new Error("The review watch failed.")));
  // fs.watch has no ready event, and macOS can miss the first change while its
  // native stream starts under load. Keep offering a harmless readiness probe
  // until that stream acknowledges one, within the original test deadline.
  // The real working-tree and index mutations below are still each made once.
  const probeReady = () => writeFile(join(root, ".git", "info", "exclude"),
    "\n# review fixture watch ready\n", { flag: "a" });
  const probing = setInterval(() => { void probeReady().catch(changed.reject); }, 300);
  t.after(() => clearInterval(probing));
  try {
    await probeReady();
    await changed.promise;
  } finally { clearInterval(probing); }

  changed = Promise.withResolvers<void>();
  waitingFor = "working-tree edit";
  await writeFile(join(cwd, "temp.ts"), "after\n");
  await rename(join(cwd, "temp.ts"), file);
  await changed.promise;
  assert.deepEqual(await listChanges(cwd), [{ path: "tracked.ts", status: " M" }]);

  changed = Promise.withResolvers<void>();
  waitingFor = "Git index update";
  // Keep the event loop available while Git creates and renames index.lock;
  // a synchronous child would force native notifications to coalesce.
  await promisify(execFile)("git", ["add", "tracked.ts"], {
    cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  await changed.promise;
  assert.deepEqual(await listChanges(cwd), [{ path: "tracked.ts", status: "M " }]);

  watch.abort();
  const finalEvents = events;
  await writeFile(file, "after closing\n");
  await delay(260);
  assert.equal(events, finalEvents);
});

test("review can watch a project before Git is initialized", { timeout: 8_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pideck-review-watch-"));
  const watch = new AbortController();
  t.after(async () => {
    watch.abort();
    await rm(cwd, { recursive: true, force: true });
  });
  const changed = Promise.withResolvers<void>();
  await watchChanges(cwd, watch.signal, changed.resolve, () => changed.reject(new Error("The review watch failed.")));
  assert.deepEqual(await listChanges(cwd), []);
  git(cwd, "init", "-q");
  await writeFile(join(cwd, "new.txt"), "hello\n");
  await changed.promise;
  assert.deepEqual(await listChanges(cwd), [{ path: "new.txt", status: "??" }]);
});

test("review watch ignores build output while retaining force-tracked files and Git metadata", { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pideck-review-ignore-"));
  const watch = new AbortController();
  t.after(async () => {
    watch.abort();
    await rm(cwd, { recursive: true, force: true });
  });
  await Promise.all(["build", "node_modules", "kept"].map(path => mkdir(join(cwd, path))));
  await writeFile(join(cwd, ".gitignore"), "build/\nnode_modules/\nkept/\n");
  await writeFile(join(cwd, "kept", "tracked.ts"), "before\n");
  git(cwd, "init", "-q");
  git(cwd, "add", ".gitignore");
  git(cwd, "add", "-f", "kept/tracked.ts");
  git(cwd, "commit", "-qm", "start");

  let changed = Promise.withResolvers<void>();
  let events = 0;
  await watchChanges(cwd, watch.signal, () => { events++; changed.resolve(); },
    () => changed.reject(new Error("The review watch failed.")));
  const probe = () => writeFile(join(cwd, ".git", "info", "exclude"), "\n# watch ready\n", { flag: "a" });
  const probing = setInterval(() => { void probe().catch(changed.reject); }, 300);
  t.after(() => clearInterval(probing));
  try { await probe(); await changed.promise; }
  finally { clearInterval(probing); }
  await delay(300);
  const baseline = events;
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    writeFile(join(cwd, index % 2 ? "build" : "node_modules", `generated ${index}.js`), "ignored\n")));
  await delay(500);
  assert.equal(events, baseline, "ignored build and dependency changes must not refresh review");

  changed = Promise.withResolvers<void>();
  await writeFile(join(cwd, "source.ts"), "new source\n");
  await changed.promise;
  changed = Promise.withResolvers<void>();
  await writeFile(join(cwd, "kept", "tracked.ts"), "after\n");
  await changed.promise;
  assert.equal((await listChanges(cwd)).find(file => file.path === "kept/tracked.ts")?.status, " M");

  changed = Promise.withResolvers<void>();
  await promisify(execFile)("git", ["add", "-f", "kept/tracked.ts"], { cwd });
  await changed.promise;
  assert.equal((await listChanges(cwd)).find(file => file.path === "kept/tracked.ts")?.status, "M ");
  changed = Promise.withResolvers<void>();
  await rm(join(cwd, "kept"), { recursive: true });
  await changed.promise;
  assert.equal((await listChanges(cwd)).find(file => file.path === "kept/tracked.ts")?.status, "MD");
});
