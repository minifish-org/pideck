import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readMessageFile, resolveMessageFile } from "../src/host/message-links";
import { validPayload } from "../src/main/validation";
import { externalMessageUrl, projectMessageLink } from "../src/shared/message-links";

test("message browser links admit explicit web navigation including local development servers", () => {
  for (const value of ["https://nodejs.org/api/assert.html#assert", "http://localhost:3000/demo", "http://127.0.0.1:8080",
    "https://example.com/a%20b?q=value#section"]) {
    assert.ok(externalMessageUrl(value), value);
    assert.equal(validPayload("link:open-external", { url: value }), true);
  }
  for (const value of ["javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd", "mailto:user@example.com",
    "//example.com", "https:example.com", "https://user:secret@example.com", "https://@example.com",
    "https://example.com\n/other", "https://example.com/%0d%0aheader", "https://example.com/%", "https://example.com\\@evil.example",
    "https://example.com:99999", " https://example.com", "https://example.com/" + "x".repeat(16_384)]) {
    assert.equal(externalMessageUrl(value), undefined, value);
    assert.equal(validPayload("link:open-external", { url: value }), false, value);
  }
  for (const value of [undefined, {}, { url: 1 }]) assert.equal(validPayload("link:open-external", value), false);
});

test("message file affordances normalize project paths without turning unsupported schemes into links", () => {
  const directory = "/work/project";
  assert.deepEqual(projectMessageLink("./src/file%20name.ts#L12-L15", directory), { path: "src/file name.ts", line: 12 });
  assert.deepEqual(projectMessageLink("docs/../README.md#section", directory), { path: "README.md" });
  assert.deepEqual(projectMessageLink("/work/project/src/file.ts:8:2", directory), { path: "src/file.ts", line: 8 });
  assert.deepEqual(projectMessageLink("%E8%AF%8D.ts#line-3", directory), { path: "词.ts", line: 3 });
  assert.deepEqual(projectMessageLink("C:\\Repo\\src\\file.ts#L4", "c:\\repo"), { path: "src/file.ts", line: 4 });
  assert.deepEqual(projectMessageLink("%252e%252e/file.ts", directory), { path: "%2e%2e/file.ts" });
  for (const value of ["../outside.ts", "%2e%2e/outside.ts", "..%5coutside.ts", "/work/project-other/a.ts", "/etc/passwd",
    "https://example.com/a.ts", "javascript:alert(1)", "file:///work/project/a.ts", "//other/a.ts", "#section", "%", "a%00b",
    "a.ts#L0", "a.ts:0", "a.ts#L9007199254740992"]) {
    assert.equal(projectMessageLink(value, directory), undefined, value);
  }
  assert.equal(projectMessageLink("D:/other/a.ts", "C:/Repo"), undefined);
});

test("trusted file resolution confines symlinks and encoded paths to the selected project", async t => {
  const temporary = await mkdtemp(join(tmpdir(), "pideck-message-link-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = join(temporary, "project");
  const outside = join(temporary, "outside");
  await Promise.all([mkdir(project), mkdir(outside)]);
  await writeFile(join(project, "词 file.ts"), "export const value = 1;\n");
  await writeFile(join(outside, "secret.ts"), "outside\n");
  await symlink(join(project, "词 file.ts"), join(project, "local-link.ts"));
  await symlink(join(outside, "secret.ts"), join(project, "escape.ts"));
  await symlink(outside, join(project, "escape-directory"), "dir");

  assert.deepEqual(await resolveMessageFile(project, "%E8%AF%8D%20file.ts#L1"), { path: "词 file.ts", line: 1 });
  assert.deepEqual(await resolveMessageFile(project, "local-link.ts"), { path: "词 file.ts" });
  await assert.rejects(resolveMessageFile(project, "escape.ts"), /outside/);
  await assert.rejects(resolveMessageFile(project, "escape-directory/secret.ts"), /outside/);
  await assert.rejects(resolveMessageFile(project, "../outside/secret.ts"), /inside/);
  await assert.rejects(resolveMessageFile(project, "missing.ts"), /no longer available/);
  await assert.rejects(resolveMessageFile(project, "escape-directory"), /outside/);
  await assert.rejects(resolveMessageFile(project, "./"), /inside/);
  const aborted = AbortSignal.abort(new Error("Project was removed."));
  await assert.rejects(resolveMessageFile(project, "local-link.ts", aborted), /Project was removed/);
});

test("file-link IPC requires an owned project identity and a bounded original href", () => {
  const projectId = randomUUID();
  assert.equal(validPayload("review:resolve-link", { projectId, href: "src/main.ts#L12" }), true);
  for (const value of [undefined, { href: "a.ts" }, { projectId: "../other", href: "a.ts" },
    { projectId, href: "" }, { projectId, href: "a\0.ts" }, { projectId, href: "a\n.ts" },
    { projectId, href: "x".repeat(16_385) }]) assert.equal(validPayload("review:resolve-link", value), false);
});

test("read-only previews bound content and preserve UTF-8 project filenames without re-decoding them", async t => {
  const temporary = await mkdtemp(join(tmpdir(), "pideck-file-preview-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = join(temporary, "project");
  const outside = join(temporary, "outside");
  await Promise.all([mkdir(project), mkdir(outside)]);
  const source = "export const 词 = 'hello';\n";
  await Promise.all([
    writeFile(join(project, "词 #%.ts"), source),
    writeFile(join(project, "empty.ts"), ""),
    writeFile(join(project, "large.ts"), "a".repeat(1024 * 1024 + 1)),
    writeFile(join(project, "binary.bin"), Buffer.from([1, 0, 2])),
    writeFile(join(project, "encoded.txt"), Buffer.from([0xff, 0xfe, 0x61])),
    writeFile(join(outside, "secret.ts"), "outside"),
  ]);
  await symlink(join(project, "词 #%.ts"), join(project, "local.ts"));
  await symlink(join(outside, "secret.ts"), join(project, "escape.ts"));
  await symlink(outside, join(project, "escape-directory"), "dir");
  assert.deepEqual(await readMessageFile(project, "词 #%.ts"), { path: "词 #%.ts", contents: source });
  assert.deepEqual(await readMessageFile(project, "local.ts"), { path: "词 #%.ts", contents: source });
  assert.deepEqual(await readMessageFile(project, "empty.ts"), { path: "empty.ts", contents: "" });
  for (const [path, reason] of [["large.ts", /1 MB/], ["binary.bin", /binary/], ["encoded.txt", /UTF-8/]] as const) {
    const preview = await readMessageFile(project, path);
    assert.equal(preview.contents, null);
    assert.match(preview.reason ?? "", reason);
  }
  for (const path of ["../outside/secret.ts", "escape.ts", "escape-directory/secret.ts", outside, "escape-directory"]) {
    await assert.rejects(readMessageFile(project, path), /inside|outside|file/);
  }
  const cancelled = AbortSignal.abort(new Error("File preview stopped."));
  await assert.rejects(readMessageFile(project, "local.ts", cancelled), /preview stopped/);
});

test("preview IPC requires an owned project, bounded path and independent cancellation identity", () => {
  const projectId = randomUUID();
  const requestId = randomUUID();
  assert.equal(validPayload("review:file", { projectId, path: "src/example.ts", requestId }), true);
  assert.equal(validPayload("review:file-cancel", { projectId, requestId }), true);
  for (const value of [undefined, {}, { projectId, path: "x" }, { projectId: "other", path: "x", requestId },
    { projectId, path: "a\n.ts", requestId }, { projectId, path: "x".repeat(4097), requestId }]) {
    assert.equal(validPayload("review:file", value), false);
  }
  for (const value of [undefined, {}, { projectId }, { projectId, requestId: "not-an-id" }]) {
    assert.equal(validPayload("review:file-cancel", value), false);
  }
});
