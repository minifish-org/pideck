import assert from "node:assert/strict";
import { test } from "node:test";
import { notificationPreview } from "../src/host/notification-preview.js";

test("notification previews flatten reply formatting without copying fenced code, images or link targets", () => {
  assert.equal(notificationPreview([
    "## 已完成",
    "",
    "- 修复 **登录** 和 `callback`；[相关测试](test/login.test.ts) 通过。",
    "![Screenshot](output/screenshot.png)",
    "![Saved image][screenshot]",
    "```typescript",
    "const privateCode = 'not a notification';",
    "```",
    "[screenshot]: output/screenshot.png",
  ].join("\n")), "已完成 修复 登录 和 callback；相关测试 通过。");
  assert.equal(notificationPreview("__Done__. ~~Old~~ *New*.\n> See [tests][checks].\n[checks]: /private/path"),
    "Done. Old New. See tests.");
});

test("notification previews omit tilde, longer and unclosed fences", () => {
  assert.equal(notificationPreview("Before.\n~~~sh\nprivate output\n~~~\nAfter."), "Before. After.");
  assert.equal(notificationPreview("Before.\n````markdown\n```\nprivate output\n```\n````\nAfter."), "Before. After.");
  assert.equal(notificationPreview("Done.\n```\nprivate output"), "Done.");
  for (const text of ["", " \n\t", "```ts\nconst hidden = true;\n```", "![Screenshot](output/image.png)", "---\n***"]) {
    assert.equal(notificationPreview(text), undefined);
  }
});

test("notification previews are one bounded line and preserve Unicode graphemes", () => {
  assert.equal(notificationPreview("\u001b[32mDone\u001b[0m.\n\t\u202eTests\u0000 passed."), "Done. Tests passed.");
  assert.equal(notificationPreview("a".repeat(161)), "a".repeat(159) + "…");
  const family = "👩‍👩‍👦";
  const preview = notificationPreview(family.repeat(100))!;
  assert.ok(preview.length <= 160);
  assert.equal(preview, family.repeat(Math.floor(159 / family.length)) + "…");
});
