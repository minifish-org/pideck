import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatchFiles } from "@pierre/diffs";
import { diffContainsLine, fileLineCount } from "../src/renderer/review-target";

test("link targets use real new-file diff lines, excluding collapsed context and deletion-only hunks", () => {
  const patch = "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n@@ -20 +20,0 @@\n-deleted\n";
  const files = parsePatchFiles(patch).flatMap(value => value.files);
  assert.equal(diffContainsLine(files, 1), true);
  assert.equal(diffContainsLine(files, 2), true);
  assert.equal(diffContainsLine(files, 3), false);
  assert.equal(diffContainsLine(files, 20), false);
  assert.equal(diffContainsLine(files, 30), false);
  assert.equal(diffContainsLine([], 1), false);
});

test("full-file anchors use actual content lines without inventing a line for a trailing newline", () => {
  assert.equal(fileLineCount(""), 0);
  assert.equal(fileLineCount("hello"), 1);
  assert.equal(fileLineCount("hello\n"), 1);
  assert.equal(fileLineCount("hello\n\n"), 2);
  assert.equal(fileLineCount("hello\r\nworld\r\n"), 2);
});
