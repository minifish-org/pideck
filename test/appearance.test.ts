import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appearanceBackground, appearanceDocument, openAppearance } from "../src/main/appearance";
import type { AppearancePreference, AppearanceState } from "../src/shared/api";

class NativeAppearance extends EventEmitter {
  themeSource: AppearancePreference = "system";
  dark = false;
  get shouldUseDarkColors() { return this.themeSource === "system" ? this.dark : this.themeSource === "dark"; }
  system(dark: boolean) { this.dark = dark; this.emit("updated"); }
}

test("system changes during the initial preference write are not missed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-appearance-"));
  class ChangingNativeAppearance extends NativeAppearance {
    scheduled = false;
    override get shouldUseDarkColors() {
      const current = super.shouldUseDarkColors;
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => this.system(true));
      }
      return current;
    }
  }
  const native = new ChangingNativeAppearance();
  const appearance = await openAppearance(directory, native);
  try {
    assert.equal(native.shouldUseDarkColors, true);
    assert.deepEqual(appearance.get(), { preference: "system", resolved: "dark" });
  } finally {
    appearance.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("new profiles follow the system across relaunch and explicit modes ignore system changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-appearance-"));
  const native = new NativeAppearance();
  let appearance = await openAppearance(directory, native);
  try {
    assert.deepEqual(appearance.get(), { preference: "system", resolved: "light" });
    assert.deepEqual(JSON.parse(await readFile(join(directory, "appearance.json"), "utf8")), { preference: "system" });
    const changes: AppearanceState[] = [];
    const unsubscribe = appearance.subscribe(state => changes.push(state));
    native.system(true);
    assert.deepEqual(changes, [{ preference: "system", resolved: "dark" }]);
    await appearance.set("light");
    assert.equal(native.themeSource, "light");
    const explicitChanges = changes.length;
    native.system(false);
    native.system(true);
    assert.equal(changes.length, explicitChanges);
    assert.deepEqual(appearance.get(), { preference: "light", resolved: "light" });
    await appearance.set("system");
    assert.deepEqual(appearance.get(), { preference: "system", resolved: "dark" });
    unsubscribe();
    appearance.dispose();
    assert.equal(native.listenerCount("updated"), 0);
    // Host startup creates this file on first launch, but must not change the
    // already-persisted System choice into a legacy Dark choice on next launch.
    await writeFile(join(directory, "workspace.sqlite"), "");
    native.dark = false;
    appearance = await openAppearance(directory, native);
    assert.deepEqual(appearance.get(), { preference: "system", resolved: "light" });
  } finally {
    appearance.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing profiles retain dark, validate saved preferences and persist rapid choices atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-appearance-"));
  const native = new NativeAppearance();
  await writeFile(join(directory, "workspace.sqlite"), "");
  await writeFile(join(directory, "appearance.json"), JSON.stringify({ preference: "invalid" }));
  let appearance = await openAppearance(directory, native);
  try {
    assert.deepEqual(appearance.get(), { preference: "dark", resolved: "dark" });
    assert.equal(native.themeSource, "dark");
    await Promise.all([appearance.set("light"), appearance.set("dark"), appearance.set("system"), appearance.set("light")]);
    await appearance.flush();
    assert.deepEqual(JSON.parse(await readFile(join(directory, "appearance.json"), "utf8")), { preference: "light" });
    if (process.platform !== "win32") assert.equal((await stat(join(directory, "appearance.json"))).mode & 0o777, 0o600);
    appearance.dispose();
    native.dark = true;
    appearance = await openAppearance(directory, native);
    assert.deepEqual(appearance.get(), { preference: "light", resolved: "light" });
  } finally {
    appearance.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("initial HTML and native canvas use the resolved appearance before renderer startup", () => {
  const html = '<!doctype html><html lang="en" data-color-mode="dark" data-dark-theme="dark"><head><meta name="color-scheme" content="dark" /></head><body><div id="root"></div></body></html>';
  for (const resolved of ["light", "dark"] as const) {
    const state = { preference: "system", resolved } as const;
    const document = appearanceDocument(html, state);
    assert.match(document, new RegExp(`data-color-mode="${resolved}"`));
    assert.match(document, /data-light-theme="light"/);
    assert.match(document, /data-dark-theme="dark"/);
    assert.equal(document.match(/data-dark-theme=/g)?.length, 1);
    assert.match(document, new RegExp(`name="color-scheme" content="${resolved}"`));
    assert.match(document, /<body><div id="root"><\/div><\/body>/);
    assert.ok(!document.includes("<script"));
    assert.equal(appearanceBackground(state), resolved === "light" ? "#ffffff" : "#0d1117");
  }
});
