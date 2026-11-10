import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";
import { openSmokeProvider } from "./smoke-provider.mjs";

async function executable() {
  if (process.argv[2]) return resolve(process.argv[2]);
  const entries = await readdir("release");
  if (process.platform === "darwin") {
    const directory = entries.find(name => name === "mac-" + process.arch) ?? "mac";
    return resolve("release", directory, "Pideck.app", "Contents", "MacOS", "Pideck");
  }
  if (process.platform === "win32") return resolve("release", "win-unpacked", "Pideck.exe");
  return resolve("release", "linux-unpacked", "pideck");
}

async function clickNativeMenu(app, id) {
  await app.evaluate(async ({ BrowserWindow, Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`Native menu item ${id} is missing.`);
    const deadline = Date.now() + 5000;
    while (!item.enabled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!item.enabled) throw new Error(`Native menu item ${id} is disabled.`);
    const window = BrowserWindow.getAllWindows()[0];
    item.click({}, window, window?.webContents);
  }, id);
}

async function chooseAppearance(app, page, preference) {
  await clickNativeMenu(app, `appearance-${preference}`);
  const state = await page.evaluate(() => window.pideck.invoke("appearance:get"));
  assert.equal(state.preference, preference);
  await page.waitForFunction(resolved => document.documentElement.dataset.colorMode === resolved, state.resolved);
  const menu = await app.evaluate(({ Menu, nativeTheme, BrowserWindow }) => ({
    source: nativeTheme.themeSource,
    selected: ["system", "light", "dark"].filter(value => Menu.getApplicationMenu().getMenuItemById(`appearance-${value}`).checked),
    background: BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase(),
  }));
  assert.equal(menu.source, preference);
  assert.deepEqual(menu.selected, [preference]);
  assert.ok((state.resolved === "light" ? ["#ffffff", "#ffffffff"] : ["#0d1117", "#ff0d1117"]).includes(menu.background));
  return state;
}

async function expectPaint(target, expected) {
  await target.evaluate((element, expected) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const color = getComputedStyle(element).backgroundColor;
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const actual = [...context.getImageData(0, 0, 1, 1).data];
    const wanted = [...expected.matchAll(/[a-f\d]{2}/gi)].map(([pair]) => parseInt(pair, 16)).concat(255);
    if (actual.some((channel, index) => Math.abs(channel - wanted[index]) > 1)) {
      throw new Error(`Diff paint expected ${expected}, received ${color} (${actual.join(",")}).`);
    }
  }, expected);
}

async function readRunClock(page) {
  const clock = page.locator(".run-clock");
  await clock.waitFor();
  return clock.evaluate(clock => {
    const startedAt = Number(clock.dataset.startedAt);
    const endedAt = clock.dataset.endedAt === undefined ? undefined : Number(clock.dataset.endedAt);
    const parts = clock.textContent.trim().split(":").map(Number);
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    const elapsed = Math.floor(Math.max(0, (endedAt ?? Date.now()) - startedAt) / 1000);
    if (!Number.isFinite(startedAt) || !Number.isFinite(seconds) || parts.length < 2
      || (endedAt === undefined ? Math.abs(elapsed - seconds) > 1 : elapsed !== seconds)
      || endedAt !== undefined && (!Number.isFinite(endedAt) || endedAt < startedAt)
      || getComputedStyle(clock).opacity !== "1" || clock.getAttribute("role") !== "timer" || clock.getAttribute("aria-live") !== "off") {
      throw new Error("The active run clock must visibly follow the persisted native start without live announcements.");
    }
    return { startedAt, endedAt, seconds };
  });
}

async function readFrozenClock(page) {
  await page.locator(".run-clock[data-ended-at]").waitFor();
  const clock = await readRunClock(page);
  assert.ok(clock.endedAt !== undefined, "The settled run lost its final elapsed time.");
  return clock;
}

async function expectCompletedRunControl(page, expectedPosition) {
  const button = page.getByRole("button", { name: "Cancel run", exact: true });
  await button.waitFor();
  assert.equal(await page.locator(".composer-run-control").count(), 1);
  assert.equal(await page.getByRole("button", { name: "Continue run", exact: true }).count(), 0);
  assert.equal(await button.isDisabled(), true);
  await button.hover();
  assert.ok(await button.evaluate(button => {
    const style = getComputedStyle(button);
    const clock = button.closest(".composer-run").querySelector(".run-clock");
    return button.dataset.action === "cancel" && Boolean(button.querySelector("svg rect"))
      && Number(style.opacity) > 0 && Number(style.opacity) <= .5 && style.color === getComputedStyle(clock).color;
  }), "Completed work must keep a muted, disabled stop icon next to the frozen total.");
  const position = await button.boundingBox();
  if (expectedPosition) assert.ok(["x", "y", "width", "height"].every(key => Math.abs(position[key] - expectedPosition[key]) <= 1),
    "The completed Cancel button moved from its running position.");
  return position;
}

async function expectQuietNativeMetadata(page, message) {
  await page.getByRole("textbox", { name: "Message Pideck", exact: true }).focus();
  await page.mouse.move(0, 0);
  const metadata = message.locator(".message-footer time, .message-footer button");
  assert.ok(await metadata.evaluateAll(items => items.length > 1 && items.every(item => getComputedStyle(item).opacity === "0")));
  await message.hover();
  assert.ok(await metadata.evaluateAll(items => items.every(item => getComputedStyle(item).opacity === "1")));
  await page.getByRole("textbox", { name: "Message Pideck", exact: true }).focus();
  await page.mouse.move(0, 0);
  await message.locator(".message-footer button").first().focus();
  assert.ok(await metadata.evaluateAll(items => items.every(item => getComputedStyle(item).opacity === "1")));
}

async function waitForQueuedEditor(page, text) {
  await page.waitForFunction(expected => {
    const editor = document.querySelector('textarea[aria-label="Edit queued message"]');
    return editor && !editor.readOnly && editor.value === expected;
  }, text);
}

async function verifyAppearanceMenu(app, page) {
  const initial = await page.evaluate(() => window.pideck.invoke("appearance:get"));
  assert.equal(initial.preference, "system", "A fresh profile should follow the system.");
  const controls = await app.evaluate(({ Menu, nativeTheme }) => {
    const menu = Menu.getApplicationMenu();
    const appearance = menu.getMenuItemById("appearance");
    const section = menu.items.find(item => item.submenu?.items.includes(appearance));
    return { section: section?.label.replace("&", ""), label: appearance?.label,
      source: nativeTheme.themeSource,
      items: appearance?.submenu.items.map(item => ({ label: item.label, type: item.type, enabled: item.enabled })) };
  });
  assert.equal(controls.section, "View");
  assert.equal(controls.label, "Appearance");
  assert.equal(controls.source, "system");
  assert.deepEqual(controls.items, ["Follow System", "Light", "Dark"].map(label => ({ label, type: "radio", enabled: true })));
  await chooseAppearance(app, page, "light");
  await page.reload();
  await page.getByRole("button", { name: /^Open (?:a project )?folder$/i }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.pideck.invoke("appearance:get")), { preference: "light", resolved: "light" });
  assert.equal(await page.locator("html").getAttribute("data-color-mode"), "light");
  await chooseAppearance(app, page, "system");
  try {
    // Drive the app-local native color signal; do not change the OS preference.
    for (const resolved of ["dark", "light"]) {
      await app.evaluate(({ nativeTheme }, resolved) => {
        nativeTheme.themeSource = resolved;
        nativeTheme.emit("updated");
      }, resolved);
      await page.waitForFunction(resolved => document.documentElement.dataset.colorMode === resolved, resolved);
      assert.deepEqual(await page.evaluate(() => window.pideck.invoke("appearance:get")), { preference: "system", resolved });
      assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("appearance-system").checked), true);
    }
  } finally {
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "system"; nativeTheme.emit("updated"); });
  }
  await chooseAppearance(app, page, "dark");
}

async function mockProjectPicker(app, directory) {
  await app.evaluate(({ dialog, Notification }, directory) => {
    // OS delivery has its own acceptance path. A disposable regression profile
    // must not request or change the user's system notification permission.
    Notification.isSupported = () => false;
    dialog.showOpenDialog = async () => directory
      ? { canceled: false, filePaths: [directory] }
      : { canceled: true, filePaths: [] };
    dialog.showMessageBox = async (_window, options) => {
      options ??= _window;
      if (options.buttons?.[1] !== "Remove" && options.message !== "Quit while work is running?") throw new Error("Unexpected native confirmation.");
      return { response: 1, checkboxChecked: false };
    };
  }, directory);
}

async function verifyNativeUpdateMenu(app) {
  if (process.platform === "darwin") {
    const state = await app.evaluate(({ app, Menu }) => {
      const { createRequire } = process.getBuiltinModule("node:module");
      const { join } = process.getBuiltinModule("node:path");
      const { readFileSync } = process.getBuiltinModule("node:fs");
      const menu = Menu.getApplicationMenu();
      const item = menu.getMenuItemById("check-for-updates");
      const section = menu.items.find(entry => entry.submenu?.items.includes(item));
      const all = [];
      function visit(items) {
        for (const entry of items) {
          all.push(entry);
          if (entry.submenu) visit(entry.submenu.items);
        }
      }
      visit(menu.items);
      const require = createRequire(join(process.resourcesPath, "app.asar", "package.json"));
      const addonPath = require.resolve(join(process.resourcesPath, "native", "pideck-sparkle.node"));
      // Inspect the addon already initialized by real application startup.
      // Loading a fresh instance here could hide a failed startup integration.
      const updater = require.cache[addonPath]?.exports;
      const manifest = JSON.parse(readFileSync(join(process.resourcesPath, "updater", "manifest.json"), "utf8"));
      return {
        packaged: app.isPackaged, arch: process.arch,
        section: section?.label.replace("&", ""), label: item?.label, enabled: item?.enabled,
        entries: all.filter(entry => entry.id === "check-for-updates").length,
        updateLabels: all.filter(entry => /^(?:Check for Updates|Restart and Update|Download Update|Install Update|View Release|Open Releases)/i.test(entry.label)).map(entry => entry.label),
        loaded: Boolean(updater),
        methods: ["start", "check", "canCheck", "resumeInstall", "dispose"].every(method => typeof updater?.[method] === "function"),
        ready: updater?.canCheck(),
        manifest: { platform: manifest.platform, arch: manifest.arch, native: manifest.native },
      };
    });
    assert.equal(state.packaged, true);
    assert.equal(state.section, "Pideck");
    assert.equal(state.label, "Check for Updates…");
    assert.equal(state.entries, 1);
    assert.deepEqual(state.updateLabels, ["Check for Updates…"]);
    assert.equal(state.loaded, true, "Application startup did not load the native updater.");
    assert.equal(state.methods, true);
    assert.equal(state.ready, true, "The initialized native updater is not ready for a user update check.");
    assert.equal(state.enabled, true);
    assert.deepEqual(state.manifest, { platform: "darwin", arch: state.arch, native: "Resources/native/pideck-sparkle.node" });
    // The dedicated update acceptance flow exercises native UI against a signed
    // local feed. This broad smoke must never contact the production feed or
    // replace Sparkle with a fabricated Electron message box.
    return;
  }
  const results = await app.evaluate(async ({ app, BrowserWindow, dialog, Menu, net, shell }) => {
    const menu = Menu.getApplicationMenu();
    const item = menu.getMenuItemById("check-for-updates");
    const section = menu.items.find(entry => entry.submenu?.items.includes(item));
    if (!item || !section || !item.enabled) throw new Error("The update check is unavailable before opening a project.");
    const endpoint = "https://api.github.com/repos/minifish-org/pideck/releases";
    const latest = `${endpoint}/latest`;
    const list = `${endpoint}?per_page=1`;
    const installed = app.getVersion();
    const label = item.label;
    const original = { fetch: net.fetch, message: dialog.showMessageBox, open: shell.openExternal };
    let fixture;
    net.fetch = async (input, ...options) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== latest && url !== list) return original.fetch.call(net, input, ...options);
      fixture.requests.push(url);
      if (url === latest && fixture.tag) return Response.json({
        tag_name: fixture.tag, draft: false, prerelease: false, html_url: "https://example.invalid/untrusted-release",
      });
      return url === list && fixture.public ? Response.json([]) : new Response(null, { status: 404 });
    };
    dialog.showMessageBox = async (...args) => {
      fixture.dialog = args.at(-1);
      return { response: fixture.response, checkboxChecked: false };
    };
    shell.openExternal = async url => { fixture.opened.push(url); };

    async function run(options) {
      fixture = { ...options, requests: [], opened: [] };
      const window = BrowserWindow.getAllWindows()[0];
      item.click({}, window, window?.webContents);
      const deadline = Date.now() + 5000;
      while ((!fixture.dialog || !item.enabled) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (!fixture.dialog || !item.enabled) throw new Error("The update check did not finish.");
      return fixture;
    }

    try {
      const unavailable = await run({ response: 1 });
      const empty = await run({ public: true, response: 0 });
      const current = await run({ tag: `v${installed}`, response: 0 });
      const available = await run({ tag: "v999.0.0", response: 0 });
      return { label, section: section.label.replace("&", ""), installed, latest, list, unavailable, empty, current, available };
    } finally {
      net.fetch = original.fetch;
      dialog.showMessageBox = original.message;
      shell.openExternal = original.open;
    }
  });
  assert.equal(results.section, process.platform === "darwin" ? "Pideck" : "File");
  assert.equal(results.label, "Check for Updates…");
  assert.equal(results.unavailable.dialog.message, "Could not check for updates");
  assert.deepEqual(results.unavailable.dialog.buttons, ["Open Releases", "Close"]);
  assert.deepEqual(results.unavailable.requests, [results.latest, results.list]);
  assert.deepEqual(results.unavailable.opened, []);
  assert.equal(results.empty.dialog.message, "No stable Pideck release is available");
  assert.equal(results.current.dialog.message, "Pideck is up to date");
  assert.equal(results.available.dialog.message, "A Pideck update is available");
  assert.ok(results.available.dialog.detail.includes(results.installed));
  assert.ok(results.available.dialog.detail.includes("999.0.0"));
  assert.deepEqual(results.available.dialog.buttons, ["View Release", "Close"]);
  assert.deepEqual(results.available.opened, ["https://github.com/minifish-org/pideck/releases/tag/v999.0.0"]);
}

async function verifyNativeTitlebar(app, page) {
  if (process.platform !== "darwin") return;
  const { bounds, minimum, position } = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { bounds: window.getBounds(), minimum: window.getMinimumSize(), position: window.getWindowButtonPosition() };
  });
  assert.deepEqual(position, { x: 20, y: 21 });
  async function measure(width, docked, inset) {
    await page.waitForFunction(({ width, docked, inset }) => {
      const overlay = navigator.windowControlsOverlay;
      if (!overlay?.visible || innerWidth !== width || document.querySelector(".app")?.classList.contains("app--nav") !== docked) return false;
      const area = overlay.getTitlebarAreaRect();
      return area.right === width && (inset === undefined || area.x === inset);
    }, { width, docked, inset });
    return page.evaluate(() => {
      const safeArea = navigator.windowControlsOverlay.getTitlebarAreaRect();
      const titlebar = document.querySelector(".titlebar").getBoundingClientRect();
      const toggle = document.getElementById("toggle-navigation").getBoundingClientRect();
      const openFolder = document.getElementById("nav-open-project")?.getBoundingClientRect();
      return {
        nativeInset: safeArea.x,
        nativeHeight: safeArea.height,
        titlebarHeight: titlebar.height,
        buttonX: toggle.x,
        buttonCenterY: toggle.y + toggle.height / 2,
        sidebarAlignment: openFolder ? toggle.left + toggle.width / 2 - (openFolder.left + openFolder.width / 2) : undefined,
      };
    });
  }
  const wide = await measure(bounds.width, true);
  try {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), minimum);
    // AppKit can report an intermediate button inset before the overlay settles.
    const narrow = await measure(minimum[0], false, wide.nativeInset);
    for (const chrome of [wide, narrow]) {
      assert.ok(chrome.nativeInset > 0 && chrome.buttonX - chrome.nativeInset >= 8);
      assert.ok(Math.abs(chrome.titlebarHeight - chrome.nativeHeight) <= 1);
      assert.ok(Math.abs(chrome.buttonCenterY - chrome.nativeHeight / 2) <= 1);
    }
    assert.ok(Math.abs(wide.sidebarAlignment) <= 1);
    assert.ok(Math.abs(narrow.buttonX - narrow.nativeInset - 8) <= 1);
  } finally {
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), bounds);
    await measure(bounds.width, true, wide.nativeInset);
  }
}

const path = await executable();
const temporary = await mkdtemp(join(tmpdir(), "pideck-packaged-"));
const data = join(temporary, "profile");
const project = join(temporary, "smoke-project");
const otherProject = join(temporary, "side-project");
const shellProfile = join(temporary, "zsh-config");
let app;
let modelServer;
const errors = [];

try {
  await Promise.all([mkdir(project), mkdir(otherProject)]);
  if (process.platform === "darwin") {
    await mkdir(shellProfile);
    await Promise.all([
      writeFile(join(shellProfile, ".zprofile"), "export PIDECK_SMOKE_LOGIN=loaded\n"),
      writeFile(join(shellProfile, ".zshrc"), "PROMPT='PIDECK_SMOKE> '\n"),
    ]);
  }
  modelServer = await openSmokeProvider();
  const git = (...args) => execFileSync("git", args, { cwd: project, stdio: "pipe" });
  git("init");
  await writeFile(join(project, "example.ts"), "export const result = 'before';\n");
  const largeFile = value => Array.from({ length: 500 }, (_, i) =>
    `export const workerLine${i} = "${value}";\n`).join("");
  await writeFile(join(project, "long-change.ts"), largeFile("beforeMarker"));
  git("add", "example.ts", "long-change.ts");
  git("-c", "user.email=test@example.invalid", "-c", "user.name=Pideck Smoke", "-c", "commit.gpgsign=false", "commit", "-m", "Fixture");
  await writeFile(join(project, "long-change.ts"), largeFile("afterMarker"));

  const launch = async () => {
    const running = await _electron.launch({
      executablePath: path,
      args: [`--user-data-dir=${data}`, ...(process.platform === "darwin" ? ["-SUEnableAutomaticChecks", "NO"] : [])],
      env: { ...process.env, AZURE_OPENAI_API_KEY: "pideck-smoke-key",
        AZURE_OPENAI_BASE_URL: modelServer.endpoint, PIDECK_SMOKE_PRIVATE: "secret-marker",
        ...(process.platform === "darwin" ? { SHELL: "/bin/zsh", ZDOTDIR: shellProfile } : {}) },
    });
    const window = await running.firstWindow();
    window.on("pageerror", error => errors.push(error.message));
    window.on("console", message => {
      if (message.type() === "error") errors.push(message.text());
    });
    await window.waitForFunction(() => Boolean(window.pideck));
    return { running, window };
  };
  const first = await launch();
  app = first.running;
  const page = first.window;

  await mockProjectPicker(app);

  assert.equal(await page.evaluate(() => typeof globalThis.require), "undefined");
  assert.equal(await page.evaluate(() => typeof globalThis.process), "undefined");
  await verifyAppearanceMenu(app, page);
  const nativeMenu = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    return {
      sections: menu.items.map(item => item.label.replace("&", "")),
      roles: menu.items.flatMap(item => item.submenu.items.map(child => child.role?.toLowerCase()).filter(Boolean)),
      workspaceItemsEnabled: ["new-session", "toggle-review", "toggle-terminal", "focus-composer"].some(id => menu.getMenuItemById(id).enabled),
    };
  });
  assert.deepEqual(nativeMenu.sections, process.platform === "darwin" ? ["Pideck", "File", "Edit", "View", "Window"] : ["File", "Edit", "View"]);
  assert.equal(nativeMenu.workspaceItemsEnabled, false);
  assert.ok(["undo", "redo", "cut", "copy", "paste", "selectall", "zoomin", "zoomout", "resetzoom"].every(role => nativeMenu.roles.includes(role)));
  assert.ok(["reload", "forcereload", "toggledevtools", "services", "showsubstitutions", "startspeaking"].every(role => !nativeMenu.roles.includes(role)));
  await verifyNativeUpdateMenu(app);
  await page.evaluate(async () => {
    window.pideck.updateMenu({ canCreateSession: true });
    await window.pideck.invoke("project:list");
  });
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("new-session").enabled), false);
  const command = (name, payload) => page.evaluate(([name, payload]) => window.pideck.invoke(name, payload), [name, payload]);
  await assert.rejects(command("appearance:get", {}), /Invalid appearance request/);
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:password@example.com/", "https://example.com/%0a"]) {
    await assert.rejects(command("link:open-external", { url }), /could not be opened safely/);
  }
  await app.evaluate(({ shell }) => {
    globalThis.__pideckSmokeLink = { original: shell.openExternal, opened: [] };
    shell.openExternal = async url => { globalThis.__pideckSmokeLink.opened.push(url); };
  });
  try {
    await command("link:open-external", { url: "https://nodejs.org/api/assert.html" });
    assert.deepEqual(await app.evaluate(() => globalThis.__pideckSmokeLink.opened), ["https://nodejs.org/api/assert.html"]);
  } finally {
    await app.evaluate(({ shell }) => {
      shell.openExternal = globalThis.__pideckSmokeLink.original;
      delete globalThis.__pideckSmokeLink;
    });
  }
  for (const name of ["project:open", "project:add", "project:inspect", "project:trust"]) {
    await assert.rejects(command(name, { directory: "/" }), /Invalid workspace request/);
  }
  await assert.rejects(command("model:auth-open", {
    flowId: crypto.randomUUID(), linkId: crypto.randomUUID(),
  }), /no longer active/);

  assert.equal(await command("project:open"), null);
  assert.deepEqual(await command("project:list"), []);
  await mockProjectPicker(app, project);
  await clickNativeMenu(app, "open-project");
  await page.waitForFunction(() => document.activeElement?.id === "prompt");
  const [added] = await command("project:list");
  assert.equal(added.name, "smoke-project");
  const projectId = added.id;
  assert.deepEqual(await command("review:resolve-link", { projectId, href: "example.ts#L1" }), { path: "example.ts", line: 1 });
  await assert.rejects(command("review:resolve-link", { projectId, href: "../outside.txt" }), /inside the selected project/);
  await assert.rejects(command("review:resolve-link", { projectId: crypto.randomUUID(), href: "example.ts" }), /project/i);
  assert.deepEqual(await command("project:open"), added);
  assert.deepEqual(await command("session:list", { projectId }), []);
  await assert.rejects(command("chat:watch", { projectId, sessionId: crypto.randomUUID(), subscriptionId: crypto.randomUUID() }), /Session not found/);

  const prompt = page.getByRole("textbox", { name: "Message Pideck" });
  const navigation = page.getByRole("complementary", { name: "Workspace navigation" });
  const projectRow = navigation.getByRole("button", { name: "smoke-project", exact: true });
  const projectSessions = navigation.getByRole("list", { name: "smoke-project sessions", exact: true });
  const leftDivider = page.getByRole("separator", { name: "Resize left sidebar", exact: true });
  const defaultNavigationWidth = (await navigation.boundingBox()).width;
  await leftDivider.press("ArrowRight");
  await page.waitForFunction(width => Math.abs(document.getElementById("workspace-navigation").getBoundingClientRect().width - width) <= 1,
    defaultNavigationWidth + 16);
  await prompt.fill("Edit example.ts and verify it.");
  await page.reload();
  await projectRow.waitFor();
  await prompt.waitFor();
  assert.ok(Math.abs((await navigation.boundingBox()).width - defaultNavigationWidth - 16) <= 1);
  await leftDivider.press("Enter");
  await page.waitForFunction(width => Math.abs(document.getElementById("workspace-navigation").getBoundingClientRect().width - width) <= 1,
    defaultNavigationWidth);
  assert.equal(await prompt.inputValue(), "Edit example.ts and verify it.");
  assert.deepEqual(await command("session:list", { projectId }), []);
  await verifyNativeTitlebar(app, page);
  await prompt.blur();
  await clickNativeMenu(app, "focus-composer");
  await page.waitForFunction(() => document.activeElement?.id === "prompt");
  const modelCatalog = await command("model:list");
  assert.ok(!JSON.stringify(modelCatalog).includes("pideck-smoke-key"));
  assert.equal(modelCatalog.savedConnectionsPending, false);
  const azure = modelCatalog.models.find(model => model.provider === "azure" && model.id === "gpt-4.1");
  assert.equal(azure?.configured, true);
  await clickNativeMenu(app, "settings");
  const providers = page.getByRole("dialog", { name: "Model providers" });
  await providers.waitFor();
  assert.equal(await app.evaluate(async ({ Menu }) => {
    const ids = ["open-project", "settings", "new-session", "toggle-review", "toggle-terminal"];
    const disabled = () => ids.every(id => !Menu.getApplicationMenu().getMenuItemById(id).enabled);
    const deadline = Date.now() + 1000;
    while (!disabled() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    return disabled();
  }), true);
  await providers.getByRole("button", { name: "Close settings" }).click();
  const modelPicker = page.getByRole("button", { name: "Model", exact: true });
  await modelPicker.click();
  const modelMenu = page.getByRole("region", { name: "Choose a model" });
  const modelSearch = modelMenu.getByRole("searchbox", { name: "Search models" });
  await modelSearch.waitFor();
  assert.equal(await modelMenu.getByRole("button", { name: "Browse all models", exact: true }).count(), 0);
  await modelSearch.fill("gpt-4.1");
  await modelMenu.getByRole("button", { name: /\bAzure\b/i })
    .filter({ has: page.getByText(azure.name, { exact: true }) }).click();
  await modelPicker.getByText(azure.name, { exact: true }).waitFor();
  assert.equal(await modelPicker.locator(".model-summary-thinking").count(), 0);
  await modelMenu.waitFor({ state: "hidden" });
  assert.equal(await modelPicker.evaluate(button => button === document.activeElement), true);

  const attachmentBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 560));
    await page.waitForFunction(() => innerWidth === 760);
    await prompt.focus();
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext("2d");
      context.fillStyle = "#238636";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([blob], "native-pasted-image.png", { type: "image/png" }));
      document.getElementById("prompt").dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    });
    const attachment = page.locator(".attachment");
    const previewImage = page.getByRole("button", { name: "Preview attached image 1", exact: true });
    await previewImage.waitFor();
    assert.ok(!(await attachment.innerText()).includes("native-pasted-image.png"));
    await previewImage.click();
    const imagePreview = page.getByRole("dialog", { name: "Image preview", exact: true });
    await imagePreview.getByRole("img", { name: "Attached image 1", exact: true }).waitFor();
    assert.ok(await imagePreview.evaluate(async dialog => {
      const rect = dialog.getBoundingClientRect();
      const close = dialog.querySelector("button").getBoundingClientRect();
      const imageElement = dialog.querySelector("img");
      await imageElement.decode();
      const image = imageElement.getBoundingClientRect();
      return rect.left === 0 && rect.top === 0 && rect.width === innerWidth && rect.height === innerHeight
        && close.top >= 8 && close.top <= 24 && innerWidth - close.right >= 8 && innerWidth - close.right <= 24
        && getComputedStyle(dialog).backgroundColor === "rgba(0, 0, 0, 0)"
        && getComputedStyle(dialog, "::backdrop").backgroundColor === "rgba(0, 0, 0, 0)"
        && image.left >= 0 && image.top >= 0 && image.right <= innerWidth && image.bottom <= innerHeight
        && imageElement.naturalWidth === 320 && imageElement.naturalHeight === 180
        && image.width === 320 && image.height === 180
        && getComputedStyle(imageElement).objectFit === "contain";
    }));
    await page.keyboard.press("Escape");
    await imagePreview.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Preview attached image 1");
    await previewImage.click();
    await imagePreview.getByRole("button", { name: "Close image preview", exact: true }).click();
    await imagePreview.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Remove attached image 1", exact: true }).click();
    await attachment.waitFor({ state: "detached" });
    assert.equal(await imagePreview.count(), 0);
    assert.equal(await prompt.inputValue(), "Edit example.ts and verify it.");
    assert.deepEqual(await command("session:list", { projectId }), []);
    assert.equal(modelServer.requests.length, 0);
  } finally {
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), attachmentBounds);
    await projectRow.waitFor();
  }

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Package stream", { exact: true }).waitFor();
  assert.equal(await page.locator(".chat-entry--assistant > .message-footer").count(), 0);
  assert.equal(await page.locator(".composer-models .model-summary-thinking").count(), 0);
  await page.getByText("Package stream verified with the real coding tools.").waitFor();
  const sentMessage = page.getByRole("article", { name: "You", exact: true }).filter({ hasText: "Edit example.ts and verify it." });
  const finalMessage = page.getByRole("article", { name: "Pideck", exact: true })
    .filter({ has: page.getByText("Package stream verified with the real coding tools.", { exact: true }) });
  await finalMessage.locator(".message-footer").waitFor();
  await page.locator('.composer-run[data-run-state="completed"]').waitFor();
  const completedClock = await readFrozenClock(page);
  await new Promise(resolve => setTimeout(resolve, 1_100));
  assert.deepEqual(await readFrozenClock(page), completedClock, "The finished stopwatch kept advancing.");
  assert.equal(await page.locator(".message-duration").count(), 0);
  await expectCompletedRunControl(page);
  for (const message of [sentMessage, finalMessage]) {
    const time = message.locator(".message-footer time");
    assert.match((await time.innerText()).trim(), /^(?:[01]\d|2[0-3]):[0-5]\d$/);
    assert.ok(Number.isFinite(Date.parse(await time.getAttribute("datetime"))));
    assert.ok(await message.evaluate(article => article.querySelector(".message-footer").getBoundingClientRect().top
      >= article.querySelector(".message-content").getBoundingClientRect().bottom - 1));
  }
  assert.equal(await sentMessage.getByRole("button", { name: "Branch from here" }).count(), 0);
  assert.equal(await finalMessage.locator(".message-footer").getByRole("button", { name: "Branch from here" }).count(), 1);
  for (const theme of ["light", "dark"]) {
    await chooseAppearance(app, page, theme);
    await expectCompletedRunControl(page);
    await expectQuietNativeMetadata(page, sentMessage);
    await expectQuietNativeMetadata(page, finalMessage);
  }
  await finalMessage.hover();
  await page.screenshot({ path: "output/playwright/pideck-native-completed-footer.png" });
  await app.evaluate(({ clipboard }) => {
    globalThis.__pideckSmokeCopy = { original: clipboard.writeText, text: undefined };
    clipboard.writeText = text => { globalThis.__pideckSmokeCopy.text = text; };
  });
  try {
    for (const [message, expected] of [[sentMessage, "Edit example.ts and verify it."],
      [finalMessage, "Package stream verified with the real coding tools."]]) {
      await message.getByRole("button", { name: "Copy message", exact: true }).click();
      await message.getByRole("button", { name: "Message copied", exact: true }).waitFor();
      assert.equal(await app.evaluate(() => globalThis.__pideckSmokeCopy.text), expected);
    }
    const shellMessage = page.getByRole("article", { name: "Pideck", exact: true })
      .filter({ has: page.locator(".tool-card summary").filter({ hasText: "cat example.ts" }) });
    assert.equal(await shellMessage.getAttribute("data-tools-only"), "true");
    assert.equal(await shellMessage.locator(".message-footer").count(), 0);
    assert.equal(await page.locator(".chat-entry--assistant > .message-footer").count(), 1);
  } finally {
    await app.evaluate(({ clipboard }) => {
      clipboard.writeText = globalThis.__pideckSmokeCopy.original;
      delete globalThis.__pideckSmokeCopy;
    });
  }
  assert.equal(await modelPicker.locator(".model-summary-thinking").count(), 0);
  const shellCard = page.locator(".tool-card").filter({ has: page.locator("summary").filter({ hasText: "cat example.ts" }) });
  assert.equal(await shellCard.locator("summary").getByText('test -z "$AZURE_OPENAI_API_KEY" && cat example.ts', { exact: true }).count(), 1);
  assert.equal(await shellCard.locator(".tool-detail").getByText(/cat example\.ts/).count(), 0);
  const sessions = await command("session:list", { projectId });
  assert.equal(sessions.length, 1);
  const [conversation] = sessions;
  await page.getByRole("button", { name: "Rename session Edit example.ts and verify it.", exact: true }).waitFor();
  await projectSessions.getByRole("button", { name: "Edit example.ts and verify it.", exact: true }).press("F2");
  const sessionName = page.getByRole("textbox", { name: "Session name", exact: true });
  await sessionName.fill("Smoke session");
  await sessionName.press("Enter");
  const smokeSession = projectSessions.getByRole("button", { name: "Smoke session", exact: true });
  await smokeSession.waitFor();
  await page.getByRole("button", { name: "Rename session Smoke session", exact: true }).waitFor();
  await navigation.getByRole("button", { name: "Collapse smoke-project", exact: true }).click();
  await projectSessions.waitFor({ state: "hidden" });
  await page.getByText("Package stream verified with the real coding tools.").waitFor();
  await navigation.getByRole("button", { name: "Expand smoke-project", exact: true }).click();
  await smokeSession.waitFor();
  assert.equal(await smokeSession.getAttribute("aria-current"), "true");
  assert.equal(await readFile(join(project, "example.ts"), "utf8"), "export const result = 'after';\n");
  assert.ok(modelServer.requests.some(request => request.input.some(item =>
    item.type === "function_call_output" && String(item.output).includes("export const result = 'after'"))));

  const review = page.getByRole("complementary", { name: "Review changes" });
  const tools = page.locator("#workspace-tools");
  const changesToggle = page.getByRole("button", { name: "Changes", exact: true });
  const terminalToggle = page.getByRole("button", { name: "Terminal", exact: true });
  const toolButtonPositions = () => Promise.all([changesToggle, terminalToggle].map(async button => (await button.boundingBox()).x));
  async function verifyClosedToolLayout() {
    await tools.waitFor({ state: "hidden" });
    assert.ok(await page.evaluate(() => {
      const middleHeader = document.querySelector(".titlebar-content");
      const terminalToggle = document.getElementById("toggle-terminal");
      const headerRight = middleHeader.getBoundingClientRect().right;
      const buttonRight = terminalToggle.getBoundingClientRect().right;
      const inset = parseFloat(getComputedStyle(middleHeader).paddingInlineEnd);
      return document.querySelectorAll("#toggle-review").length === 1 && document.querySelectorAll("#toggle-terminal").length === 1
        && middleHeader.contains(document.getElementById("toggle-review")) && middleHeader.contains(terminalToggle)
        && Math.abs(headerRight - window.innerWidth) <= 1 && Math.abs(buttonRight - (window.innerWidth - inset)) <= 1;
    }), "The middle header and its tool buttons must extend to the window edge while the right sidebar is closed.");
  }
  async function verifyDockedToolLayout(panelSelector) {
    assert.ok(await page.evaluate(selector => {
      const bounds = target => document.querySelector(target).getBoundingClientRect();
      const sameEdge = (first, second) => Math.abs(first - second) <= 1;
      const right = bounds("#workspace-tools[data-docked]");
      const titlebar = bounds(".titlebar");
      const middleHeaderElement = document.querySelector(".titlebar-content");
      const middleHeader = middleHeaderElement.getBoundingClientRect();
      const panelHeaderElement = document.querySelector(selector + " .workspace-panel-header");
      const panelHeader = panelHeaderElement.getBoundingClientRect();
      const panelHeaderEnd = middleHeader.right - parseFloat(getComputedStyle(middleHeaderElement).paddingInlineEnd);
      const reviewToggle = bounds("#toggle-review");
      const terminalToggle = bounds("#toggle-terminal");
      const panel = bounds(selector);
      const otherControls = [...middleHeaderElement.querySelectorAll("h2, button, input, select")]
        .filter(control => !control.closest('[aria-label="Workspace panels"]') && control.getClientRects().length);
      return document.querySelectorAll("#toggle-review").length === 1 && document.querySelectorAll("#toggle-terminal").length === 1
        && middleHeaderElement.contains(document.getElementById("toggle-review"))
        && middleHeaderElement.contains(document.getElementById("toggle-terminal"))
        && sameEdge(bounds(".workspace-conversation").right, right.left)
        && sameEdge(middleHeader.right, titlebar.right)
        && bounds(".workspace-title").right <= middleHeader.right
        && terminalToggle.left >= reviewToggle.right && sameEdge(terminalToggle.right, panelHeaderEnd)
        && sameEdge((terminalToggle.top + terminalToggle.bottom) / 2, (middleHeader.top + middleHeader.bottom) / 2)
        && otherControls.every(control => control.getBoundingClientRect().right <= reviewToggle.left + 1)
        && sameEdge(panel.top, titlebar.bottom)
        && panelHeader.bottom > titlebar.bottom
        && sameEdge(panel.left, right.left) && sameEdge(panel.right, right.right)
        && sameEdge(panel.bottom, right.bottom);
    }, panelSelector), "The active tool must fill the right sidebar, with one fixed pair of toggle buttons at the global titlebar's right edge without overlapping other controls.");
  }
  await verifyClosedToolLayout();
  await clickNativeMenu(app, "toggle-review");
  await page.getByRole("navigation", { name: "Changed files" }).getByRole("button", { name: /example.ts/ }).click();
  await page.getByRole("combobox", { name: "Diff layout" }).selectOption("split");
  await page.locator("diffs-container").filter({ hasText: "after" }).last().waitFor();
  await page.getByRole("navigation", { name: "Changed files" }).getByRole("button", { name: /long-change.ts/ }).click();
  const highlighted = page.locator("diffs-container").filter({ hasText: "afterMarker" });
  await highlighted.locator("[data-line] span[style]").filter({ hasText: "export" }).first().waitFor();
  assert.ok(page.workers().some(worker => worker.url().includes("/worker-")));
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("toggle-review").checked), true);
  await verifyDockedToolLayout("#review-panel");
  const dockedToolButtonPositions = await toolButtonPositions();
  const externalPath = join(project, "outside-edit.ts");
  const changedFile = review.getByRole("button", { name: /outside-edit\.ts/ });
  assert.equal(await review.getByRole("button", { name: /Refresh/i }).count(), 0);
  await writeFile(externalPath, "export const source = 'externalMarker';\n");
  await changedFile.click();
  await review.locator("diffs-container").filter({ hasText: "externalMarker" }).waitFor();

  await page.evaluate(() => {
    let output = "";
    window.pideck.onEvent(event => {
      if (event.type !== "terminal:data") return;
      document.documentElement.dataset.ptyId = event.terminalId;
      output = (output + event.data).slice(-256);
      if (output.includes("RAIL_COLLAPSED")) document.documentElement.dataset.collapsedPtyId = event.terminalId;
    });
  });
  await clickNativeMenu(app, "toggle-terminal");
  await page.getByText("Shell running").waitFor();
  const terminalRegion = page.getByRole("region", { name: "Project terminal" });
  const terminal = terminalRegion.locator(".xterm-helper-textarea");
  const terminalRows = terminalRegion.locator(".xterm-rows");
  const terminalScreen = terminalRegion.locator(".xterm-screen");
  const terminalTrack = terminalRegion.locator(".xterm-scrollable-element > .scrollbar.vertical");
  const terminalPainted = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function expectTerminalHistory(text) {
    const target = terminalRows.getByText(text, { exact: true });
    const screen = await terminalScreen.boundingBox();
    assert.ok(screen, "Expected a visible terminal while checking retained output.");
    await terminalScreen.hover();
    let found = false;
    // Read the rendered history through normal terminal scrolling. Half-screen
    // steps overlap, so a short marker cannot be skipped between viewports.
    for (let pageNumber = 0; pageNumber < 80; pageNumber++) {
      if (await target.isVisible()) { found = true; break; }
      await page.mouse.wheel(0, -screen.height / 2);
      await terminalPainted();
    }
    assert.ok(found, `Retained terminal history did not contain ${text}. Visible rows: ${await terminalRows.innerText()}`);
    await page.mouse.wheel(0, 100_000);
    await terminalPainted();
    await terminal.focus();
  }
  const restartShell = terminalRegion.getByRole("button", { name: "Restart shell", exact: true });
  assert.equal(await terminalRegion.getByRole("button", { name: "Find in terminal", exact: true }).count(), 0);
  assert.equal(await terminalRegion.getByRole("searchbox").count(), 0);
  assert.equal((await restartShell.innerText()).trim(), "");
  assert.equal(await restartShell.locator("svg").count(), 1);
  assert.equal(await restartShell.getAttribute("title"), "Restart shell (stops the current shell and its foreground command)");
  const [restartBox, panelsBox] = await Promise.all([restartShell.boundingBox(), changesToggle.boundingBox()]);
  assert.ok(restartBox && panelsBox && restartBox.y >= panelsBox.y + panelsBox.height
    && await restartShell.evaluate(button => Boolean(button.closest(".workspace-panel-header"))),
  "The icon-only restart button stays in the terminal header below the fixed global panel switches.");
  if (process.platform === "darwin") await terminalRows.getByText("PIDECK_SMOKE>", { exact: true }).waitFor();
  const firstPty = await page.waitForFunction(() => document.documentElement.dataset.ptyId).then(handle => handle.jsonValue());
  await review.waitFor({ state: "detached" });
  assert.equal(await changesToggle.getAttribute("aria-pressed"), "false");
  assert.equal(await terminalToggle.getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("separator", { name: "Resize terminal" }).count(), 0);
  await verifyDockedToolLayout("#workspace-terminal");
  assert.deepEqual(await toolButtonPositions(), dockedToolButtonPositions, "Switching between docked tools moved their toolbar buttons.");

  // Release each stage only once the running process's terminal is hidden.
  await terminal.focus();
  await page.keyboard.insertText(process.platform === "win32"
    ? 'Write-Host ("RAIL_" + "RUNNING"); while (!(Test-Path ../review-ready)) { Start-Sleep -Milliseconds 50 }; '
      + `Set-Content outside-edit.ts "export const source = 'terminalMarker';"; `
      + 'while (!(Test-Path ../collapse-ready)) { Start-Sleep -Milliseconds 50 }; Write-Host ("RAIL_" + "COLLAPSED")'
    : "printf 'RAIL_%s\\n' RUNNING; while [ ! -f ../review-ready ]; do sleep 0.05; done; "
      + `printf '%s\\n' "export const source = 'terminalMarker';" > outside-edit.ts; `
      + "while [ ! -f ../collapse-ready ]; do sleep 0.05; done; printf 'RAIL_%s\\n' COLLAPSED");
  await page.keyboard.press("Enter");
  await terminalRows.getByText("RAIL_RUNNING", { exact: true }).waitFor();
  await changesToggle.click();
  await terminalRegion.waitFor({ state: "hidden" });
  await changedFile.click();
  assert.equal(await terminalToggle.getAttribute("aria-pressed"), "false");
  assert.equal(await changesToggle.getAttribute("aria-pressed"), "true");
  await writeFile(join(temporary, "review-ready"), "");
  await review.locator("diffs-container").filter({ hasText: "terminalMarker" }).waitFor();
  await rm(externalPath);
  await changedFile.waitFor({ state: "detached" });
  await terminalToggle.click();
  await review.waitFor({ state: "detached" });
  await terminalRegion.getByText("Shell running").waitFor();
  await terminalToggle.click();
  await verifyClosedToolLayout();
  assert.equal(await terminalToggle.getAttribute("aria-pressed"), "false");
  await writeFile(join(temporary, "collapse-ready"), "");
  await page.waitForFunction(id => document.documentElement.dataset.collapsedPtyId === id, firstPty);
  await terminalToggle.click();
  await terminalRows.getByText("RAIL_COLLAPSED", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.ptyId), firstPty);

  await terminal.focus();
  const print = process.platform === "win32"
    ? 'if ($null -eq $env:PIDECK_SMOKE_PRIVATE -and $null -eq $env:AZURE_OPENAI_API_KEY) { Write-Host ("PTY_" + "OK") -ForegroundColor Green }'
    : (process.platform === "darwin" ? 'test "$PIDECK_SMOKE_LOGIN" = loaded && ' : '')
      + 'test -z "$PIDECK_SMOKE_PRIVATE$AZURE_OPENAI_API_KEY" && printf \'\\033[32mPTY_%s\\033[0m\\n\' OK';
  await page.keyboard.insertText(print);
  await page.keyboard.press("Enter");
  await page.locator(".xterm-rows").getByText("PTY_OK", { exact: true }).waitFor();
  const ansiOutput = terminalRows.getByText("PTY_OK", { exact: true });
  const darkAnsiColor = await ansiOutput.evaluate(element => getComputedStyle(element).color);
  await terminal.evaluate(element => { element.dataset.appearanceFixture = "same"; });
  await changesToggle.click();
  await review.getByRole("navigation", { name: "Changed files" }).getByRole("button", { name: /long-change\.ts/ }).click();
  const themeLayout = review.getByRole("combobox", { name: "Diff layout" });
  await themeLayout.selectOption("split");
  await highlighted.locator("[data-diff-type=split]").waitFor();
  const reviewTop = await review.locator(".workspace-review-scroll").evaluate(async element => {
    element.scrollTop = 900;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return element.scrollTop;
  });
  assert.ok(reviewTop > 800);
  const darkToken = await highlighted.locator('[data-line] span[style]').filter({ hasText: "export" }).first()
    .evaluate(element => getComputedStyle(element).color);
  await chooseAppearance(app, page, "light");
  assert.equal(await themeLayout.inputValue(), "split");
  await page.waitForFunction(top => Math.abs(document.querySelector('#review-panel .workspace-review-scroll').scrollTop - top) <= 2, reviewTop);
  await page.waitForFunction(dark => [...document.querySelectorAll('#review-panel diffs-container')]
    .flatMap(container => [...container.shadowRoot.querySelectorAll('[data-line] span[style]')])
    .some(element => element.textContent.includes("export") && getComputedStyle(element).color !== dark), darkToken);
  assert.equal(await navigation.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(246, 248, 250)");
  assert.equal(await sentMessage.locator(".message-content").evaluate(element => getComputedStyle(element).backgroundColor), "rgb(230, 234, 239)");
  assert.equal(await sentMessage.locator(".message-content").evaluate(element => getComputedStyle(element).color), "rgb(31, 35, 40)");
  for (const [type, line, gutter] of [["addition", "#dafbe1", "#aceebb"], ["deletion", "#ffebe9", "#ffcecb"]]) {
    await expectPaint(review.locator(`[data-line][data-line-type="change-${type}"]`).first(), line);
    await expectPaint(review.locator(`[data-column-number][data-line-type="change-${type}"]`).first(), gutter);
  }
  await mkdir("output/playwright", { recursive: true });
  await page.screenshot({ path: "output/playwright/pideck-native-light-workspace.png" });
  await terminalToggle.click();
  await terminalRows.getByText("PTY_OK", { exact: true }).waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#workspace-terminal .xterm-scrollable-element'))
    .backgroundColor === "rgb(246, 248, 250)");
  assert.ok(await terminalRegion.evaluate(region => [...region.querySelectorAll(".xterm, .xterm-viewport")]
    .every(element => getComputedStyle(element).backgroundColor === "rgb(246, 248, 250)")),
  "Light terminal roots and unused viewport space must not expose xterm's default black background.");
  assert.equal(await terminal.getAttribute("data-appearance-fixture"), "same");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.ptyId), firstPty);
  assert.notEqual(await ansiOutput.evaluate(element => getComputedStyle(element).color), darkAnsiColor);
  const lightTerminalRows = await terminalRows.innerText();
  await page.screenshot({ path: "output/playwright/pideck-native-light-terminal.png" });
  await chooseAppearance(app, page, "dark");
  assert.equal(await terminalRows.innerText(), lightTerminalRows, "Changing appearance must preserve the terminal viewport and output.");
  assert.equal(await terminal.getAttribute("data-appearance-fixture"), "same");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.ptyId), firstPty);
  await changesToggle.click();
  assert.equal(await themeLayout.inputValue(), "split");
  await page.waitForFunction(top => Math.abs(document.querySelector('#review-panel .workspace-review-scroll').scrollTop - top) <= 2, reviewTop);
  await terminalToggle.click();
  await expectTerminalHistory("PTY_OK");
  await terminal.press("Control+f");
  assert.equal(await terminalRegion.getByRole("searchbox").count(), 0, "Ctrl+F must remain a shell key, not open an application search.");

  await terminal.focus();
  await page.keyboard.insertText(process.platform === "win32"
    ? 'Write-Host ("INTERRUPT_" + "READY"); Start-Sleep -Seconds 30'
    : "printf 'INTERRUPT_%s\\n' READY; sleep 30");
  await page.keyboard.press("Enter");
  await terminalRows.getByText("INTERRUPT_READY", { exact: true }).waitFor();
  await page.keyboard.press("Control+c");
  await page.keyboard.insertText(process.platform === "win32" ? 'Write-Host ("INTERRUPT_" + "OK")' : "printf 'INTERRUPT_%s\\n' OK");
  await page.keyboard.press("Enter");
  await terminalRows.getByText("INTERRUPT_OK", { exact: true }).waitFor({ timeout: 6_000 });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.ptyId), firstPty);

  await page.keyboard.insertText(process.platform === "win32"
    ? 'Set-Content ../restart-shell-pid $PID; Write-Host ("RESTART_" + "READY"); Start-Sleep -Seconds 30'
    : `echo "$$" > ../restart-shell-pid; sh -c 'echo "$$" > ../restart-job-pid; printf "RESTART_%s\\n" READY; exec sleep 30'`);
  await page.keyboard.press("Enter");
  await terminalRows.getByText("RESTART_READY", { exact: true }).waitFor();
  const stoppedPids = await Promise.all((process.platform === "win32" ? ["restart-shell-pid"] : ["restart-shell-pid", "restart-job-pid"])
    .map(async name => Number(await readFile(join(temporary, name), "utf8"))));
  assert.ok(stoppedPids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  await terminal.evaluate(input => { input.dataset.restartFixture = "same"; });
  await restartShell.click();
  const restartedPty = await page.waitForFunction(id => {
    const current = document.documentElement.dataset.ptyId;
    return current && current !== id ? current : false;
  }, firstPty).then(handle => handle.jsonValue());
  await terminalRegion.getByText("Shell running").waitFor();
  assert.equal(await terminalToggle.getAttribute("aria-pressed"), "true");
  assert.equal(await terminal.getAttribute("data-restart-fixture"), "same");
  const restartDeadline = Date.now() + 5_000;
  for (const pid of stoppedPids) {
    while (true) {
      try { process.kill(pid, 0); }
      catch (error) {
        if (error.code === "ESRCH") break;
        throw error;
      }
      assert.ok(Date.now() < restartDeadline, "Restart left the previous shell or its foreground command running.");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  await expectTerminalHistory("RESTART_READY");

  await page.keyboard.insertText("exit");
  await page.keyboard.press("Enter");
  await terminalRegion.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.id === "toggle-terminal");
  await clickNativeMenu(app, "toggle-terminal");
  await terminalRegion.getByText("Shell running").waitFor();
  await page.waitForFunction(id => document.documentElement.dataset.ptyId && document.documentElement.dataset.ptyId !== id, restartedPty);
  await expectTerminalHistory("INTERRUPT_OK");

  const boundsBeforeReview = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const activePty = await page.evaluate(() => document.documentElement.dataset.ptyId);
  await terminal.focus();
  await page.keyboard.insertText(process.platform === "win32"
    ? 'Start-Sleep -Seconds 1; Write-Host ("REVIEW_" + "PTY_OK")'
    : 'sleep 1; printf \'REVIEW_%s\\n\' PTY_OK');
  await page.keyboard.press("Enter");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 560));
  await terminalRegion.getByRole("button", { name: "Back to chat" }).waitFor();
  await changesToggle.click();
  await review.getByRole("button", { name: "Back to chat" }).waitFor();
  await terminalRegion.waitFor({ state: "hidden" });
  await terminalToggle.click();
  await review.waitFor({ state: "detached" });
  await terminalRegion.getByRole("button", { name: "Back to chat" }).waitFor();
  await terminalRows.getByText("REVIEW_PTY_OK", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.ptyId), activePty);
  await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), boundsBeforeReview);
  await projectRow.waitFor();

  await terminal.focus();
  const continueInBackground = process.platform === "win32"
    ? 'Start-Sleep -Seconds 1; Write-Host ("PROJECT_" + "PTY_OK")'
    : 'sleep 1; printf \'PROJECT_%s\\n\' PTY_OK';
  await page.keyboard.insertText(continueInBackground);
  await page.keyboard.press("Enter");
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, otherProject);
  await navigation.getByRole("button", { name: "Open folder…", exact: true }).click();
  const sideProject = navigation.getByRole("button", { name: "side-project", exact: true });
  await sideProject.waitFor();
  assert.equal(await sideProject.getAttribute("aria-current"), "true");
  assert.equal(await navigation.getByRole("list", { name: "side-project sessions", exact: true }).count(), 0);
  await smokeSession.waitFor();
  await page.getByRole("region", { name: "Project terminal" }).waitFor({ state: "hidden" });
  await projectRow.click();
  await page.locator(".xterm-rows").getByText("PROJECT_PTY_OK", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), `nav-project-${projectId}`);
  await sideProject.press("Backspace");
  await sideProject.waitFor({ state: "detached" });

  async function verifyTerminalScrollSpace() {
    const [screen, track, viewport] = await Promise.all([
      terminalScreen.boundingBox(), terminalTrack.boundingBox(), terminalRegion.locator(".xterm").boundingBox(),
    ]);
    assert.ok(screen && track && viewport, "Expected a rendered terminal and scroll track.");
    assert.ok(screen.x + screen.width <= track.x + 0.5, "The scroll track overlaps the terminal's final column.");
    assert.ok(screen.y + screen.height <= viewport.y + viewport.height + 0.5, "The terminal's final row is clipped.");
  }
  await terminal.focus();
  await page.keyboard.insertText(process.platform === "win32"
    ? '1..120 | ForEach-Object { Write-Host ("History {0:D3}  Terminal output" -f $_) }; Write-Host ("SCROLL_" + "LAST")'
    : 'awk \'BEGIN { for (i = 1; i <= 120; i++) printf "History %03d  Terminal output\\n", i }\'; printf "SCROLL_%s\\n" LAST');
  await page.keyboard.press("Enter");
  const scrollLast = terminalRows.getByText("SCROLL_LAST", { exact: true });
  await scrollLast.waitFor();
  await verifyTerminalScrollSpace();
  await terminalScreen.hover();
  await page.mouse.wheel(0, -800);
  await scrollLast.waitFor({ state: "hidden" });
  const thumb = terminalTrack.and(terminalRegion.locator(".visible")).locator(".slider");
  await thumb.waitFor();
  const thumbBounds = await thumb.boundingBox();
  const trackBounds = await terminalTrack.boundingBox();
  assert.ok(thumbBounds && trackBounds);
  const thumbX = thumbBounds.x + thumbBounds.width / 2;
  await page.mouse.move(thumbX, thumbBounds.y + thumbBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumbX, trackBounds.y + trackBounds.height - 2, { steps: 10 });
  await page.mouse.up();
  await scrollLast.waitFor();

  if (process.platform !== "win32") {
    await terminalRegion.waitFor();
    await terminal.focus();
    async function ptySize(filename) {
      await page.keyboard.insertText(`stty size > ${filename}`);
      await page.keyboard.press("Enter");
      const deadline = Date.now() + 4000;
      let dimensions = "";
      while (!dimensions && Date.now() < deadline) {
        dimensions = await readFile(join(project, filename), "utf8").catch(() => "");
        if (!dimensions) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.match(dimensions, /^[1-9]\d* [1-9]\d*\n$/);
      return dimensions;
    }
    const original = await ptySize(".pty-original");
    const widthDivider = page.getByRole("separator", { name: "Resize right sidebar" });
    await widthDivider.press("Shift+ArrowLeft");
    await terminal.focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const widened = await ptySize(".pty-widened");
    assert.ok(Number(widened.split(" ")[1]) > Number(original.split(" ")[1]));
    await verifyTerminalScrollSpace();
    await widthDivider.press("Enter");
    await terminal.focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await ptySize(".pty-width-reset"), original);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1045, 680));
    await page.waitForFunction(() => window.innerWidth === 1045);
    await projectRow.waitFor();
    await verifyDockedToolLayout("#workspace-terminal");
    await clickNativeMenu(app, "focus-composer");
    await page.waitForFunction(() => document.activeElement?.id === "prompt");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 560));
    await terminalRegion.getByRole("button", { name: "Back to chat" }).waitFor();
    await terminal.focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.notEqual(await ptySize(".pty-resized"), original);
    await verifyTerminalScrollSpace();
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), boundsBeforeReview);
    await page.locator("#workspace-tools[data-docked]").waitFor();
  }

  const heldQueue = page.getByRole("list", { name: "Queued messages" });
  const heldRunningBadge = smokeSession.locator("[data-activity=running]");
  function lastProviderInput(request) {
    const content = request.input.findLast(item => item.role === "user")?.content;
    return typeof content === "string" ? content
      : (content ?? []).flatMap(block => typeof block.text === "string" ? [block.text] : []).join("\n");
  }
  const queueInputRequests = held => modelServer.requests.slice(held.start)
    .map(lastProviderInput).filter(text => text !== held.marker);
  async function beginQueueHold(name) {
    const marker = `Queue hold ${name}`;
    const original = `${name} original first`;
    const revised = `${name} revised first`;
    const following = [`${name} second`, `${name} third`];
    const ordinaryDraft = `${name} ordinary unsent draft`;
    const start = modelServer.requests.length;
    await prompt.fill(marker);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await modelServer.waitForGate(marker);
    await page.getByText(`${marker}: current run`, { exact: true }).waitFor();
    for (const text of [original, ...following]) {
      await prompt.fill(text);
      await prompt.press("Enter");
      await heldQueue.getByText(text, { exact: true }).waitFor();
    }
    const ids = await heldQueue.getByRole("listitem").evaluateAll(rows => rows.map(row => row.dataset.queueId));
    await prompt.fill(ordinaryDraft);
    await heldQueue.getByRole("listitem").filter({ hasText: original })
      .getByRole("button", { name: "Edit message", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Edit queued message", exact: true });
    await waitForQueuedEditor(page, original);
    assert.equal(await editor.inputValue(), original);
    await editor.fill(revised);
    const row = heldQueue.locator(`[data-queue-id="${ids[0]}"]`);
    await row.getByRole("status", { name: "Editing queued message", exact: true }).waitFor();
    return { marker, original, revised, following, ordinaryDraft, start, ids, row, editor };
  }
  async function expectHeldAfterMain(held) {
    modelServer.releaseGate(held.marker);
    await page.getByText(`${held.marker}: current run finished.`, { exact: true }).waitFor();
    await heldRunningBadge.waitFor({ state: "hidden" });
    // The first run has completed for real. Give an incorrectly released queue
    // a chance to reach the local provider before asserting that it stayed held.
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(queueInputRequests(held), [], "An edited queue must not execute after the current run ends.");
    assert.deepEqual(await heldQueue.getByRole("listitem").evaluateAll(rows => rows.map(row => row.dataset.queueId)), held.ids);
    await waitForQueuedEditor(page, held.revised);
    assert.equal(await held.editor.inputValue(), held.revised);
    await held.row.getByRole("status", { name: "Editing queued message", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save queued message", exact: true }).isEnabled(), true);
  }
  async function finishQueueHold(held, save, extra = []) {
    await page.getByRole("button", { name: save ? "Save queued message" : "Cancel queue edit", exact: true }).click();
    await heldQueue.waitFor({ state: "detached" });
    await page.locator(".chat-turn").last().locator(".chat-entry--assistant > .message-footer").waitFor();
    await heldRunningBadge.waitFor({ state: "hidden" });
    assert.deepEqual(queueInputRequests(held), [save ? held.revised : held.original, ...held.following, ...extra],
      "Saving or cancelling must release the original queue in order exactly once.");
    assert.equal(await prompt.inputValue(), held.ordinaryDraft);
    assert.equal(await page.locator(".composer").getByRole("button", { name: /draft|restore/i }).count(), 0);
    assert.equal(await page.getByText("Edits saved as a draft", { exact: true }).count(), 0);
    const submitted = await page.getByRole("article", { name: "You", exact: true }).allTextContents();
    const omitted = save ? held.original : held.revised;
    assert.ok(submitted.every(text => !text.includes(omitted)), "Unsubmitted queue text must not become a user message.");
  }
  async function restartWorkspaceHost() {
    await app.evaluate(({ app }) => {
      const host = app.getAppMetrics().find(metric => metric.name === "Pideck workspace");
      if (!host) throw new Error("Workspace process was not found.");
      process.kill(host.pid, "SIGKILL");
    });
  }

  const savedHold = await beginQueueHold("SAVE");
  await expectHeldAfterMain(savedHold);
  const lateInput = "SAVE added after the first run ended";
  await command("chat:send", { projectId, sessionId: conversation.id, requestId: randomUUID(), text: lateInput,
    model: { provider: azure.provider, id: azure.id }, thinking: "off", delivery: "send" });
  await heldQueue.getByText(lateInput, { exact: true }).waitFor();
  assert.deepEqual(queueInputRequests(savedHold), [], "An idle send must queue behind an outstanding edit.");
  await finishQueueHold(savedHold, true, [lateInput]);

  const cancelledHold = await beginQueueHold("CANCEL");
  await expectHeldAfterMain(cancelledHold);
  await finishQueueHold(cancelledHold, false);

  const stoppedHold = await beginQueueHold("STOP");
  await page.getByRole("button", { name: "Cancel run", exact: true }).click();
  await heldQueue.waitFor({ state: "detached" });
  await heldRunningBadge.waitFor({ state: "hidden" });
  assert.deepEqual(queueInputRequests(stoppedHold), [], "Stop must abort held inputs rather than briefly releasing them.");
  assert.equal(await prompt.inputValue(), `${stoppedHold.ordinaryDraft}\n\n${stoppedHold.revised}`,
    "Stop keeps unsaved editing text in the ordinary draft without creating another draft list.");
  assert.equal(await page.locator(".composer").getByRole("button", { name: /draft|restore/i }).count(), 0);
  const stoppedMessages = await page.getByRole("article", { name: "You", exact: true }).allTextContents();
  assert.ok(stoppedMessages.every(text => [stoppedHold.original, stoppedHold.revised, ...stoppedHold.following]
    .every(stopped => !text.includes(stopped))), "Stopped queued inputs must not become transcript messages.");
  const persistedDrafts = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith("pideck.draft.v1/")).map(([, value]) => value));
  assert.ok(persistedDrafts.length > 0);
  for (const draft of persistedDrafts) assert.doesNotMatch(draft, /"(?:recoveredDrafts|recoveryKind)"/);
  modelServer.releaseGate(stoppedHold.marker);

  const restartedHold = await beginQueueHold("RESTART");
  const beforeHostRestartClock = await readRunClock(page);
  await restartWorkspaceHost();
  await modelServer.waitForGate(restartedHold.marker, 2);
  await terminalRegion.getByText("Shell running").waitFor();
  const afterHostRestartClock = await readRunClock(page);
  assert.equal(afterHostRestartClock.startedAt, beforeHostRestartClock.startedAt,
    "Workspace recovery must retain the original run stopwatch epoch.");
  assert.ok(afterHostRestartClock.seconds >= beforeHostRestartClock.seconds);
  await expectHeldAfterMain(restartedHold);
  await finishQueueHold(restartedHold, true);

  await page.evaluate(() => {
    window.pideck.onEvent(event => {
      if (event.type === "host:restart") document.documentElement.dataset.hostRestarted = "true";
    });
  });
  await prompt.fill("Recover the active request");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Recovery request is in progress.", { exact: true }).waitFor();
  const runningBadge = smokeSession.locator("[data-activity=running]");
  await runningBadge.waitFor();
  const queue = page.getByRole("list", { name: "Queued messages" });
  const queuedRow = text => queue.getByRole("listitem").filter({ hasText: text });
  const queueAction = (text, action) => queuedRow(text).getByRole("group", { name: "Queued message actions", exact: true })
    .getByRole("button", { name: action, exact: true }).click();
  const firstQueued = "Guide the recovery when possible.";
  const draftQueued = "Original queued text.";
  const editedQueued = "Edited queued text.";
  const discardedQueued = "Remove this queued text.";
  const movedQueued = "Process this follow-up first.";
  for (const text of [firstQueued, draftQueued, discardedQueued, movedQueued]) {
    await prompt.fill(text);
    await prompt.press("Enter");
    await queuedRow(text).waitFor();
  }
  await queueAction(draftQueued, "Edit message");
  const editQueued = page.getByRole("textbox", { name: "Edit queued message" });
  await waitForQueuedEditor(page, draftQueued);
  assert.equal(await editQueued.inputValue(), draftQueued);
  await editQueued.fill(editedQueued);
  await page.getByRole("button", { name: "Save queued message", exact: true }).click();
  await queuedRow(editedQueued).waitFor();
  await queueAction(discardedQueued, "Delete message");
  await queuedRow(discardedQueued).waitFor({ state: "detached" });
  await queuedRow(movedQueued).locator(".queued-message").dragTo(queuedRow(editedQueued).locator(".queued-row"), {
    sourcePosition: { x: 14, y: 15 }, targetPosition: { x: 14, y: 5 },
  });
  await queue.getByRole("listitem").nth(1).getByText(movedQueued, { exact: true }).waitFor();
  await queueAction(firstQueued, "Steer current run");
  await queuedRow(firstQueued).getByText("Steering", { exact: true }).waitFor();
  await restartWorkspaceHost();
  await page.waitForFunction(() => document.documentElement.dataset.hostRestarted === "true");
  await page.getByText("Shell running").waitFor();
  await page.getByText("Recovered after host restart.", { exact: true }).waitFor({ timeout: 35_000 });
  await page.getByText(editedQueued, { exact: true }).waitFor();
  await queue.waitFor({ state: "detached" });
  await runningBadge.waitFor({ state: "detached" });
  assert.equal(await page.getByText("Recover the active request", { exact: true }).count(), 1);
  const sentQueue = await page.getByRole("article", { name: "You", exact: true }).allTextContents();
  const queueMessages = sentQueue.flatMap(message => [firstQueued, movedQueued, editedQueued].filter(text => message.includes(text)));
  assert.deepEqual(queueMessages, [firstQueued, movedQueued, editedQueued]);
  assert.ok(sentQueue.every(message => !message.includes(discardedQueued) && !message.includes(draftQueued)));
  await expectTerminalHistory("PTY_OK");
  const reloadedHold = await beginQueueHold("RELOAD");
  await page.reload();
  await waitForQueuedEditor(page, reloadedHold.revised);
  assert.equal(await reloadedHold.editor.inputValue(), reloadedHold.revised,
    "Reload must retain the unsaved queue edit in this window.");
  await expectHeldAfterMain(reloadedHold);
  await finishQueueHold(reloadedHold, false);
  assert.equal((await command("session:list", { projectId }))[0].id, conversation.id);
  await prompt.fill("Resume this draft after reopening.");
  await chooseAppearance(app, page, "light");
  const savedWindow = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
  const clockBeforeFullReopen = await readFrozenClock(page);
  await app.close();
  app = undefined;

  const reopened = await launch();
  app = reopened.running;
  const reopenedPage = reopened.window;
  assert.deepEqual(await reopenedPage.evaluate(() => window.pideck.invoke("appearance:get")), { preference: "light", resolved: "light" });
  await reopenedPage.waitForFunction(() => document.documentElement.dataset.colorMode === "light");
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("appearance-light").checked), true);
  await chooseAppearance(app, reopenedPage, "dark");
  const restoredWindow = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
  assert.equal(restoredWindow.width, savedWindow.width);
  assert.equal(restoredWindow.height, savedWindow.height);
  if (process.platform === "darwin") {
    assert.equal(restoredWindow.x, savedWindow.x);
    assert.equal(restoredWindow.y, savedWindow.y);
  }
  const reopenedPrompt = reopenedPage.getByRole("textbox", { name: "Message Pideck" });
  await reopenedPrompt.waitFor();
  assert.deepEqual(await readFrozenClock(reopenedPage), clockBeforeFullReopen,
    "Reopening the application changed the retained finished stopwatch.");
  assert.equal(await reopenedPrompt.inputValue(), "Resume this draft after reopening.");
  assert.equal((await reopenedPage.evaluate(() => window.pideck.invoke("project:list")))[0].id, projectId);
  assert.equal((await reopenedPage.evaluate(id => window.pideck.invoke("session:list", { projectId: id }), projectId))[0].id, conversation.id);
  await app.evaluate(({ dialog }) => {
    globalThis.removalConfirmed = false;
    globalThis.removalDialogs = 0;
    dialog.showMessageBox = async (_window, options) => {
      if (options.buttons[1] !== "Remove") throw new Error("Expected native removal confirmation.");
      globalThis.removalDialogs++;
      return { response: globalThis.removalConfirmed ? 1 : 0, checkboxChecked: false };
    };
  });
  await reopenedPage.getByRole("button", { name: "Smoke session", exact: true }).click();
  await reopenedPage.getByText("Recovered after host restart.", { exact: true }).waitFor();
  const recoveredMessage = reopenedPage.getByRole("article", { name: "Pideck" }).filter({ hasText: "Recovered after host restart." });
  await recoveredMessage.hover();
  await recoveredMessage.getByRole("button", { name: "Branch from here" }).click();
  const branch = reopenedPage.getByRole("button", { name: "Smoke session (fork)", exact: true });
  await branch.waitFor();
  const parentRemove = reopenedPage.getByRole("button", { name: "Remove session Smoke session", exact: true });
  await parentRemove.press("Enter");
  await reopenedPage.getByText("Remove this session’s branches first.", { exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.removalDialogs), 0);
  await reopenedPage.getByRole("button", { name: "Open branch Smoke session (fork)", exact: true }).click();
  assert.equal(await branch.getAttribute("aria-current"), "true");

  const branchRemove = reopenedPage.getByRole("button", { name: "Remove session Smoke session (fork)", exact: true });
  await branchRemove.press("Enter");
  await reopenedPage.waitForFunction(() => document.querySelector("button[aria-label='Remove session Smoke session (fork)']")
    ?.getAttribute("aria-disabled") !== "true");
  assert.equal(await app.evaluate(() => globalThis.removalDialogs), 1);
  assert.equal(await branch.count(), 1);
  await app.evaluate(() => { globalThis.removalConfirmed = true; });
  await reopenedPage.getByRole("button", { name: "Smoke session", exact: true }).click();
  await reopenedPage.evaluate(sessionId => {
    window.pideck.onEvent(event => {
      if (event.type === "chat:reset" && event.sessionId === sessionId) document.documentElement.dataset.survivorReattached = "true";
    });
  }, conversation.id);
  await branchRemove.press("Enter");
  await branch.waitFor({ state: "detached" });
  await reopenedPage.waitForFunction(() => document.documentElement.dataset.survivorReattached === "true");
  await reopenedPage.getByText("Recovered after host restart.", { exact: true }).waitFor();
  await reopenedPage.getByRole("button", { name: "Terminal", exact: true }).click();
  await reopenedPage.getByText("Shell running").waitFor();
  const removeProject = reopenedPage.getByRole("complementary", { name: "Workspace navigation" })
    .getByRole("button", { name: "Remove project smoke-project", exact: true });
  await removeProject.press("Enter");
  await reopenedPage.getByRole("heading", { name: "Open a project folder", exact: true }).waitFor();
  await reopenedPage.getByRole("region", { name: "Project terminal" }).waitFor({ state: "detached" });
  assert.deepEqual(await reopenedPage.evaluate(() => window.pideck.invoke("project:list")), []);
  assert.equal(await readFile(join(project, "example.ts"), "utf8"), "export const result = 'after';\n");
  await app.close();
  app = undefined;

  const cleaned = await launch();
  app = cleaned.running;
  assert.deepEqual(await cleaned.window.evaluate(() => window.pideck.invoke("project:list")), []);
  await mockProjectPicker(app, project);
  let restoredPage = cleaned.window;
  if (process.platform === "darwin") {
    await app.evaluate(({ BrowserWindow }) => new Promise(resolve => {
      const window = BrowserWindow.getAllWindows()[0];
      window.once("closed", () => resolve());
      window.close();
    }));
    const reopenedWindow = app.waitForEvent("window");
    await clickNativeMenu(app, "open-project");
    restoredPage = await reopenedWindow;
  } else await clickNativeMenu(app, "open-project");
  await restoredPage.getByRole("textbox", { name: "Message Pideck" }).waitFor();
  await restoredPage.getByRole("complementary", { name: "Workspace navigation" })
    .getByRole("button", { name: "smoke-project", exact: true }).waitFor();
  const [readded] = await restoredPage.evaluate(() => window.pideck.invoke("project:list"));
  assert.notEqual(readded.id, projectId);
  assert.deepEqual(await restoredPage.evaluate(id => window.pideck.invoke("session:list", { projectId: id }), readded.id), []);
  async function verifyNativeRunControls(targetPage) {
    const previousBounds = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const previous = window.getBounds();
      window.setBounds({ ...previous, width: 1280, height: 820 });
      return previous;
    });
    const input = targetPage.getByRole("textbox", { name: "Message Pideck", exact: true });
    const takeControlScreenshots = async stage => {
      for (const theme of ["dark", "light"]) {
        await chooseAppearance(app, targetPage, theme);
        if (stage === "tool-running") await tool.hover();
        if (stage === "completed") await expectCompletedRunControl(targetPage);
        await targetPage.screenshot({ path: `output/playwright/pideck-native-run-controls-${stage}-${theme}.png` });
      }
      await chooseAppearance(app, targetPage, "dark");
    };
    await input.fill("Native tool cancellation.");
    await targetPage.getByRole("button", { name: "Send", exact: true }).click();
    const tool = targetPage.locator(".tool-card").filter({ hasText: "NATIVE_TOOL_READY" });
    await tool.locator(".tool-output").filter({ hasText: "NATIVE_TOOL_READY" }).waitFor();
    const cancelTool = tool.getByRole("button", { name: "Cancel this tool", exact: true });
    await cancelTool.waitFor();
    assert.equal(await targetPage.getByRole("button", { name: "Cancel run", exact: true }).count(), 1);
    await input.focus();
    await targetPage.mouse.move(0, 0);
    const initialClock = await readRunClock(targetPage);
    assert.equal(initialClock.endedAt, undefined);
    const initialRunButtonPosition = await targetPage.getByRole("button", { name: "Cancel run", exact: true }).boundingBox();
    const initialRunClockPosition = await targetPage.locator(".run-clock").boundingBox();
    await targetPage.waitForFunction(previous => {
      const clock = document.querySelector(".run-clock");
      return clock && clock.textContent.trim().split(":").map(Number).reduce((total, part) => total * 60 + part, 0) > previous;
    }, initialClock.seconds);
    assert.equal((await readRunClock(targetPage)).startedAt, initialClock.startedAt);
    await targetPage.reload();
    await cancelTool.waitFor();
    const reattachedClock = await readRunClock(targetPage);
    assert.equal(reattachedClock.startedAt, initialClock.startedAt, "Reopening the active view reset the run stopwatch.");
    assert.ok(reattachedClock.seconds >= initialClock.seconds);
    await takeControlScreenshots("tool-running");
    await cancelTool.click();
    const toolFinished = targetPage.getByRole("article", { name: "Pideck", exact: true })
      .filter({ hasText: "The long command was cancelled; the rest of the work completed." });
    await toolFinished.locator(".message-footer").waitFor();
    await targetPage.locator('.composer-run[data-run-state="completed"]').waitFor();
    const toolCompletedClock = await readFrozenClock(targetPage);
    assert.equal(toolCompletedClock.startedAt, initialClock.startedAt);
    assert.equal(await readFile(join(project, "tool-cancel-result.txt"), "utf8"), "Tool cancelled; remaining work completed.\n");
    assert.equal(await targetPage.getByRole("button", { name: "Continue run", exact: true }).count(), 0);
    assert.equal(await cancelTool.count(), 0);
    assert.equal(await tool.locator('.tool-state[aria-label="Cancelled"]').count(), 1);
    assert.ok(!(await tool.locator(".tool-output").textContent()).includes("CANCEL_WAS_MISSED"));
    assert.equal(await targetPage.locator(".message-duration").count(), 0);
    await expectCompletedRunControl(targetPage, initialRunButtonPosition);
    const initialCompletedClockPosition = await targetPage.locator(".run-clock").boundingBox();
    assert.ok(["x", "y", "width", "height"].every(key => Math.abs(initialCompletedClockPosition[key] - initialRunClockPosition[key]) <= 1),
      "The frozen clock moved from its running position.");

    const continuationStart = modelServer.requests.length;
    await input.fill("Native continue check.");
    await targetPage.getByRole("button", { name: "Send", exact: true }).click();
    await targetPage.locator(".tool-output").filter({ hasText: "NATIVE_RUN_READY" }).waitFor();
    const beforeCancelClock = await readRunClock(targetPage);
    assert.equal(beforeCancelClock.endedAt, undefined);
    assert.ok(beforeCancelClock.startedAt > toolCompletedClock.startedAt, "A new input retained the previous run's clock.");
    await input.fill("This queued input must be withdrawn.");
    await targetPage.getByRole("button", { name: "Queue next", exact: true }).click();
    const controlsQueue = targetPage.getByRole("list", { name: "Queued messages", exact: true });
    await controlsQueue.getByText("This queued input must be withdrawn.", { exact: true }).waitFor();
    const draft = "Keep this unsent control draft.";
    await input.fill(draft);
    const usersBeforeContinue = await targetPage.getByRole("article", { name: "You", exact: true }).allTextContents();
    const cancelRun = targetPage.getByRole("button", { name: "Cancel run", exact: true });
    await cancelRun.hover();
    const buttonPosition = await cancelRun.boundingBox();
    const beforeCancelClockPosition = await targetPage.locator(".run-clock").boundingBox();
    await cancelRun.click();
    await controlsQueue.waitFor({ state: "detached" });
    const continueRun = targetPage.getByRole("button", { name: "Continue run", exact: true });
    await continueRun.waitFor();
    assert.equal(await continueRun.isEnabled(), true);
    await continueRun.hover();
    const continuePosition = await continueRun.boundingBox();
    assert.ok(Math.abs(buttonPosition.x - continuePosition.x) <= 1 && Math.abs(buttonPosition.y - continuePosition.y) <= 1,
      "Cancelling queued work moved the shared run-control position.");
    const cancelledClockPosition = await targetPage.locator(".run-clock").boundingBox();
    assert.ok(["x", "y", "width", "height"].every(key => Math.abs(cancelledClockPosition[key] - beforeCancelClockPosition[key]) <= 1),
      "Cancelling queued work moved the frozen clock.");
    assert.equal(await input.inputValue(), draft);
    assert.equal(await targetPage.locator(".chat-run-error").count(), 0);
    const cancelledClock = await readFrozenClock(targetPage);
    assert.equal(cancelledClock.startedAt, beforeCancelClock.startedAt);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.deepEqual(await readFrozenClock(targetPage), cancelledClock, "The cancelled run's stopwatch kept counting.");
    assert.deepEqual(await targetPage.getByRole("article", { name: "You", exact: true }).allTextContents(), usersBeforeContinue);
    await takeControlScreenshots("cancelled");

    await targetPage.reload();
    await continueRun.waitFor();
    assert.deepEqual(await readFrozenClock(targetPage), cancelledClock, "Reopening a cancelled run lost its frozen duration.");
    assert.equal(await input.inputValue(), draft, "Reattaching a cancelled run lost the draft.");
    await continueRun.click();
    await targetPage.waitForFunction(previousStart => {
      const clock = document.querySelector(".run-clock");
      return clock && !clock.hasAttribute("data-ended-at") && Number(clock.dataset.startedAt) > previousStart;
    }, beforeCancelClock.startedAt);
    const continuedClock = await readRunClock(targetPage);
    assert.equal(continuedClock.endedAt, undefined);
    assert.ok(continuedClock.startedAt > beforeCancelClock.startedAt, "Continue reused the cancelled run's elapsed-time origin.");
    const continued = targetPage.getByRole("article", { name: "Pideck", exact: true })
      .filter({ hasText: "Continued the cancelled run and verified the result." });
    await continued.locator(".message-footer").waitFor();
    await targetPage.locator('.composer-run[data-run-state="completed"]').waitFor();
    const finishedContinueClock = await readFrozenClock(targetPage);
    assert.equal(finishedContinueClock.startedAt, continuedClock.startedAt);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.deepEqual(await readFrozenClock(targetPage), finishedContinueClock);
    assert.equal(await targetPage.locator(".message-duration").count(), 0);
    await expectCompletedRunControl(targetPage, buttonPosition);
    const continuedClockPosition = await targetPage.locator(".run-clock").boundingBox();
    assert.ok(["x", "y", "width", "height"].every(key => Math.abs(continuedClockPosition[key] - beforeCancelClockPosition[key]) <= 1),
      "Completing Continue moved the frozen clock.");
    assert.equal(await continued.getByRole("button", { name: "Branch from here", exact: true }).count(), 1);
    assert.equal(await readFile(join(project, "continue-result.txt"), "utf8"), "Continued work completed.\n");
    assert.equal(await input.inputValue(), draft, "Continue submitted or erased the ordinary draft.");
    assert.deepEqual(await targetPage.getByRole("article", { name: "You", exact: true }).allTextContents(), usersBeforeContinue,
      "Native Continue must not append another user message.");
    assert.equal(await targetPage.locator('.composer-run[data-run-state="completed"]').count(), 1);
    assert.ok(modelServer.requests.slice(continuationStart).every(request => lastProviderInput(request) === "Native continue check."),
      "Continue sent a draft, synthetic instruction, or withdrawn queued message to the model.");
    await continued.hover();
    await takeControlScreenshots("completed");
    await targetPage.reload();
    await continued.locator(".message-footer").waitFor();
    assert.deepEqual(await readFrozenClock(targetPage), finishedContinueClock);
    assert.equal(await targetPage.locator(".message-duration").count(), 0);
    await expectCompletedRunControl(targetPage, buttonPosition);
    assert.equal(await input.inputValue(), draft);
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), previousBounds);
  }
  await verifyNativeRunControls(restoredPage);
  async function beginDetachedQueueHold(targetPage, name) {
    const marker = `Queue hold ${name}`;
    const original = `${name} original queued input`;
    const revised = `${name} unsaved queue edit`;
    const following = `${name} later queued input`;
    const ordinaryDraft = `${name} ordinary unsent draft`;
    const requestStart = modelServer.requests.length;
    const closePrompt = targetPage.getByRole("textbox", { name: "Message Pideck", exact: true });
    const closeQueue = targetPage.getByRole("list", { name: "Queued messages" });
    await closePrompt.fill(marker);
    await targetPage.getByRole("button", { name: "Send", exact: true }).click();
    await modelServer.waitForGate(marker);
    for (const text of [original, following]) {
      await closePrompt.fill(text);
      await closePrompt.press("Enter");
      await closeQueue.getByText(text, { exact: true }).waitFor();
    }
    await closePrompt.fill(ordinaryDraft);
    await closeQueue.getByRole("listitem").filter({ hasText: original })
      .getByRole("button", { name: "Edit message", exact: true }).click();
    await waitForQueuedEditor(targetPage, original);
    await targetPage.getByRole("textbox", { name: "Edit queued message", exact: true }).fill(revised);
    const ids = await closeQueue.getByRole("listitem").evaluateAll(rows => rows.map(row => row.dataset.queueId));
    modelServer.releaseGate(marker);
    await targetPage.getByText(`${marker}: current run finished.`, { exact: true }).waitFor();
    await targetPage.locator(".chat-running").waitFor({ state: "detached" });
    assert.deepEqual(modelServer.requests.slice(requestStart).map(lastProviderInput), [marker]);
    return { marker, original, revised, following, ordinaryDraft, requestStart, ids };
  }
  async function expectDetachedQueueHold(targetPage, held) {
    const editor = targetPage.getByRole("textbox", { name: "Edit queued message", exact: true });
    await waitForQueuedEditor(targetPage, held.revised);
    assert.equal(await editor.inputValue(), held.revised, "The reopened window must preserve the unsaved editor text.");
    const queue = targetPage.getByRole("list", { name: "Queued messages" });
    await queue.getByRole("status", { name: "Editing queued message", exact: true }).waitFor();
    assert.deepEqual(await queue.getByRole("listitem").evaluateAll(rows => rows.map(row => row.dataset.queueId)), held.ids);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(modelServer.requests.slice(held.requestStart).map(lastProviderInput), [held.marker],
      "Closing or quitting must not implicitly cancel editing or execute queued input.");
  }
  async function finishDetachedQueueHold(targetPage, held, save) {
    await targetPage.getByRole("button", { name: save ? "Save queued message" : "Cancel queue edit", exact: true }).click();
    await targetPage.getByRole("list", { name: "Queued messages" }).waitFor({ state: "detached" });
    await targetPage.locator(".chat-turn").last().locator(".chat-entry--assistant > .message-footer").waitFor();
    await targetPage.locator(".chat-running").waitFor({ state: "detached" });
    assert.deepEqual(modelServer.requests.slice(held.requestStart).map(lastProviderInput),
      [held.marker, save ? held.revised : held.original, held.following],
      "Only an explicit save or cancel may release the preserved queue, in order and once.");
    assert.equal(await targetPage.getByRole("textbox", { name: "Edit queued message", exact: true }).count(), 0);
    assert.equal(await targetPage.getByRole("textbox", { name: "Message Pideck", exact: true }).inputValue(), held.ordinaryDraft);
    const messages = await targetPage.getByRole("article", { name: "You", exact: true }).allTextContents();
    const chosen = save ? held.revised : held.original;
    const omitted = save ? held.original : held.revised;
    assert.ok(messages.some(text => text.includes(chosen)) && messages.some(text => text.includes(held.following)));
    assert.ok(messages.every(text => !text.includes(omitted)));
  }
  if (process.platform === "darwin") {
    const closedHold = await beginDetachedQueueHold(restoredPage, "CLOSE");
    // The first did-navigate handler retires the frame while preserving its
    // window's hold. Closing before a new frame reclaims it must keep that hold.
    await app.evaluate(({ BrowserWindow }) => new Promise(resolve => {
      const window = BrowserWindow.getAllWindows()[0];
      window.once("closed", resolve);
      window.webContents.once("did-navigate", () => window.close());
      window.webContents.reload();
    }));
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(modelServer.requests.slice(closedHold.requestStart).map(lastProviderInput), [closedHold.marker]);
    const opened = app.waitForEvent("window");
    await clickNativeMenu(app, "open-project");
    restoredPage = await opened;
    await expectDetachedQueueHold(restoredPage, closedHold);
    await finishDetachedQueueHold(restoredPage, closedHold, true);
  }
  const quitHold = await beginDetachedQueueHold(restoredPage, "QUIT");
  await app.close();
  app = undefined;
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(modelServer.requests.slice(quitHold.requestStart).map(lastProviderInput), [quitHold.marker]);
  const resumedEdit = await launch();
  app = resumedEdit.running;
  await expectDetachedQueueHold(resumedEdit.window, quitHold);
  await finishDetachedQueueHold(resumedEdit.window, quitHold, false);
  assert.deepEqual(errors, []);
  assert.deepEqual(modelServer.failures, []);
  console.log("Packaged Electron verified: native menus, coding and host recovery, native run Continue and tool cancellation, native PTY, and permanent workspace and session removal.");
} catch (error) {
  if (errors.length) console.error("Renderer errors:", errors);
  if (modelServer?.failures.length) console.error("Provider fixture errors:", modelServer.failures);
  throw error;
} finally {
  await app?.close();
  await modelServer?.close();
  await rm(temporary, { recursive: true, force: true });
}
