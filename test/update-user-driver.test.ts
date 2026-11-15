import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const resources = fileURLToPath(new URL(`../release/updater-assets/mac-${process.arch}/`, import.meta.url));
const source = fileURLToPath(new URL("./support/update-user-driver.mm", import.meta.url));

// Native coverage is opt-in on macOS: npm run prepare:update && npm test.
// Reuse the authenticated packaging SDK, without downloading during tests.
test("native updater installs after one choice and never reuses consent after cancellation, failure or another update", {
  skip: process.platform !== "darwin" ? "Requires macOS AppKit and Sparkle"
    : !existsSync(resources) ? "Run npm run prepare:update to prepare the pinned native SDK" : false,
}, async () => {
  const { validateUpdaterResources } = await import(new URL("../scripts/update-assets.mjs", import.meta.url).href);
  const manifest = await validateUpdaterResources(resources, { verifyPreparedHashes: true });
  const archive = fileURLToPath(new URL(`../release/updater-downloads/node-v${manifest.electronVersion}-headers.tar.gz`, import.meta.url));
  assert.equal(createHash("sha256").update(await readFile(archive)).digest("hex"), manifest.electronHeadersSha256);
  const temporary = await mkdtemp(join(tmpdir(), "pideck-update-user-driver-"));
  try {
    const headers = join(temporary, "headers");
    const executable = join(temporary, "update-user-driver");
    await mkdir(headers);
    await run("/usr/bin/tar", ["-xzf", archive, "-C", headers, "--strip-components", "1"]);
    const frameworks = join(resources, "Frameworks");
    await run("/usr/bin/xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-fblocks",
      "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter", "-DNAPI_VERSION=8", "-DNODE_GYP_MODULE_NAME=pideck_sparkle",
      "-I", join(headers, "include/node"), "-F", frameworks, "-framework", "Sparkle", "-framework", "Foundation", "-framework", "AppKit",
      "-undefined", "dynamic_lookup", `-Wl,-rpath,${frameworks}`, source, "-o", executable]);
    const { stdout } = await run(executable);
    assert.match(stdout, /consent, automatic installation, and reset checks passed/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
