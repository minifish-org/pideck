import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

async function verifyNativeUpdateMenu(app) {
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
  async function measure(width, inset) {
    await page.waitForFunction(({ width, inset }) => {
      const overlay = navigator.windowControlsOverlay;
      if (!overlay?.visible || innerWidth !== width) return false;
      const area = overlay.getTitlebarAreaRect();
      return area.right === width && (inset === undefined || area.x === inset);
    }, { width, inset });
    return page.evaluate(() => {
      const safeArea = navigator.windowControlsOverlay.getTitlebarAreaRect();
      const titlebar = document.querySelector(".titlebar").getBoundingClientRect();
      const toggle = document.getElementById("toggle-navigation").getBoundingClientRect();
      return {
        nativeInset: safeArea.x,
        nativeHeight: safeArea.height,
        titlebarHeight: titlebar.height,
        buttonX: toggle.x,
        buttonCenterY: toggle.y + toggle.height / 2,
      };
    });
  }
  const wide = await measure(bounds.width);
  try {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), minimum);
    // AppKit can report an intermediate button inset before the overlay settles.
    const narrow = await measure(minimum[0], wide.nativeInset);
    for (const chrome of [wide, narrow]) {
      assert.ok(chrome.nativeInset > 0 && chrome.buttonX - chrome.nativeInset >= 8);
      assert.ok(Math.abs(chrome.titlebarHeight - chrome.nativeHeight) <= 1);
      assert.ok(Math.abs(chrome.buttonCenterY - chrome.nativeHeight / 2) <= 1);
    }
    assert.equal(wide.buttonX, narrow.buttonX);
  } finally {
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), bounds);
    await measure(bounds.width, wide.nativeInset);
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
      args: [`--user-data-dir=${data}`],
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

  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, project);

  assert.equal(await page.evaluate(() => typeof globalThis.require), "undefined");
  assert.equal(await page.evaluate(() => typeof globalThis.process), "undefined");
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
  await assert.rejects(page.evaluate(() => window.pideck.invoke("project:add", { directory: "/" })), /Invalid workspace request/);
  await assert.rejects(page.evaluate(() => window.pideck.invoke("model:auth-open", {
    flowId: crypto.randomUUID(), linkId: crypto.randomUUID(),
  })), /no longer active/);

  await clickNativeMenu(app, "open-project");
  await page.getByRole("button", { name: "Review permissions", exact: true }).waitFor();
  const [added] = await page.evaluate(() => window.pideck.invoke("project:list"));
  assert.equal(added.name, "smoke-project");
  assert.equal(added.trusted, false);
  const projectId = added.id;
  const command = (name, payload) => page.evaluate(([name, payload]) => window.pideck.invoke(name, payload), [name, payload]);
  await assert.rejects(command("terminal:open", { projectId, cols: 80, rows: 20 }), /Trust this project/);
  await assert.rejects(command("review:list", { projectId }), /Trust this project/);
  assert.equal(await command("project:trust", { projectId }), null);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.id === "prompt");
  assert.equal((await command("project:list"))[0].trusted, true);
  assert.deepEqual(await command("session:list", { projectId }), []);
  await assert.rejects(command("chat:watch", { projectId, sessionId: crypto.randomUUID(), subscriptionId: crypto.randomUUID() }), /Session not found/);

  const prompt = page.getByRole("textbox", { name: "Message Pideck" });
  const navigation = page.getByRole("complementary", { name: "Workspace navigation" });
  const projectRow = navigation.getByRole("button", { name: "smoke-project", exact: true });
  const projectSessions = navigation.getByRole("list", { name: "smoke-project sessions", exact: true });
  await prompt.fill("Edit example.ts and verify it.");
  await page.reload();
  await projectRow.waitFor();
  await prompt.waitFor();
  assert.equal(await prompt.inputValue(), "Edit example.ts and verify it.");
  assert.deepEqual(await command("session:list", { projectId }), []);
  await verifyNativeTitlebar(app, page);
  await prompt.blur();
  await clickNativeMenu(app, "focus-composer");
  await page.waitForFunction(() => document.activeElement?.id === "prompt");
  const modelList = await command("model:list");
  assert.ok(!JSON.stringify(modelList).includes("pideck-smoke-key"));
  const azure = modelList.find(model => model.provider === "azure" && model.id === "gpt-4.1");
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
  await modelPicker.getByText("Off", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Package stream", { exact: true }).waitFor();
  await page.getByText("Package stream verified with the real coding tools.").waitFor();
  const sessions = await command("session:list", { projectId });
  assert.equal(sessions.length, 1);
  const [conversation] = sessions;
  await projectSessions.getByRole("button", { name: "Edit example.ts and verify it.", exact: true }).press("F2");
  const sessionName = page.getByRole("textbox", { name: "Session name", exact: true });
  await sessionName.fill("Smoke session");
  await sessionName.press("Enter");
  const smokeSession = projectSessions.getByRole("button", { name: "Smoke session", exact: true });
  await smokeSession.waitFor();
  await navigation.getByRole("button", { name: "Collapse smoke-project", exact: true }).click();
  await projectSessions.waitFor({ state: "hidden" });
  await page.getByText("Package stream verified with the real coding tools.").waitFor();
  await navigation.getByRole("button", { name: "Expand smoke-project", exact: true }).click();
  await smokeSession.waitFor();
  assert.equal(await smokeSession.getAttribute("aria-current"), "true");
  assert.equal(await readFile(join(project, "example.ts"), "utf8"), "export const result = 'after';\n");
  assert.ok(modelServer.requests.some(request => request.input.some(item =>
    item.type === "function_call_output" && String(item.output).includes("export const result = 'after'"))));

  await clickNativeMenu(app, "toggle-review");
  await page.getByRole("navigation", { name: "Changed files" }).getByRole("button", { name: /example.ts/ }).click();
  await page.getByRole("combobox", { name: "Diff layout" }).selectOption("split");
  await page.locator("diffs-container").filter({ hasText: "after" }).last().waitFor();
  await page.getByRole("navigation", { name: "Changed files" }).getByRole("button", { name: /long-change.ts/ }).click();
  const highlighted = page.locator("diffs-container").filter({ hasText: "afterMarker" });
  await highlighted.locator("[data-line] span[style]").filter({ hasText: "export" }).first().waitFor();
  assert.ok(page.workers().some(worker => worker.url().includes("/worker-")));
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("toggle-review").checked), true);

  await page.evaluate(() => {
    window.pideck.onEvent(event => {
      if (event.type === "terminal:data") document.documentElement.dataset.ptyId = event.terminalId;
    });
  });
  await clickNativeMenu(app, "toggle-terminal");
  await page.getByText("Shell running").waitFor();
  const terminalRegion = page.getByRole("region", { name: "Project terminal" });
  const terminal = terminalRegion.locator(".xterm-helper-textarea");
  const terminalRows = terminalRegion.locator(".xterm-rows");
  assert.equal(await terminalRegion.getByRole("button", { name: /end shell|restart shell/i }).count(), 0);
  if (process.platform === "darwin") await terminalRows.getByText("PIDECK_SMOKE>", { exact: true }).waitFor();
  const firstPty = await page.waitForFunction(() => document.documentElement.dataset.ptyId).then(handle => handle.jsonValue());
  const review = page.getByRole("complementary", { name: "Review changes" });
  const externalPath = join(project, "outside-edit.ts");
  const changedFile = review.getByRole("button", { name: /outside-edit\.ts/ });
  assert.equal(await review.getByRole("button", { name: /Refresh/i }).count(), 0);
  await writeFile(externalPath, "export const source = 'externalMarker';\n");
  await changedFile.click();
  await review.locator("diffs-container").filter({ hasText: "externalMarker" }).waitFor();
  await terminal.focus();
  await page.keyboard.insertText(process.platform === "win32"
    ? `Set-Content outside-edit.ts "export const source = 'terminalMarker';"`
    : `printf '%s\\n' "export const source = 'terminalMarker';" > outside-edit.ts`);
  await page.keyboard.press("Enter");
  await review.locator("diffs-container").filter({ hasText: "terminalMarker" }).waitFor();
  await rm(externalPath);
  await changedFile.waitFor({ state: "detached" });
  await terminal.focus();
  const print = process.platform === "win32"
    ? 'if ($null -eq $env:PIDECK_SMOKE_PRIVATE -and $null -eq $env:AZURE_OPENAI_API_KEY) { Write-Host ("PTY_" + "OK") -ForegroundColor Green }'
    : (process.platform === "darwin" ? 'test "$PIDECK_SMOKE_LOGIN" = loaded && ' : '')
      + 'test -z "$PIDECK_SMOKE_PRIVATE$AZURE_OPENAI_API_KEY" && printf \'\\033[32mPTY_%s\\033[0m\\n\' OK';
  await page.keyboard.insertText(print);
  await page.keyboard.press("Enter");
  await page.locator(".xterm-rows").getByText("PTY_OK", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Find in terminal" }).click();
  await page.getByRole("searchbox", { name: "Find in terminal output" }).fill("PTY_OK");
  const match = page.locator(".workspace-search-results");
  await match.filter({ hasText: /[1-9]\d* (?:of|results)/ }).waitFor({ timeout: 5_000 }).catch(async error => {
    const text = await match.allTextContents();
    throw new Error("Terminal search status was " + text.join(" "), { cause: error });
  });
  await page.getByRole("searchbox", { name: "Find in terminal output" }).press("Escape");

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
  await page.keyboard.insertText("exit");
  await page.keyboard.press("Enter");
  await terminalRegion.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.id === "toggle-terminal");
  await clickNativeMenu(app, "toggle-terminal");
  await terminalRegion.getByText("Shell running").waitFor();
  await page.waitForFunction(id => document.documentElement.dataset.ptyId && document.documentElement.dataset.ptyId !== id, firstPty);
  await terminalRegion.getByRole("button", { name: "Find in terminal" }).click();
  const retainedSearch = terminalRegion.getByRole("searchbox", { name: "Find in terminal output" });
  await retainedSearch.fill("INTERRUPT_OK");
  await match.filter({ hasText: /[1-9]\d* (?:of|results)/ }).waitFor();
  await retainedSearch.press("Escape");

  const boundsBeforeReview = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  await terminal.focus();
  await page.keyboard.insertText(process.platform === "win32"
    ? 'Start-Sleep -Seconds 1; Write-Host ("REVIEW_" + "PTY_OK")'
    : 'sleep 1; printf \'REVIEW_%s\\n\' PTY_OK');
  await page.keyboard.press("Enter");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 560));
  await review.getByRole("button", { name: "Back to chat" }).waitFor();
  await page.getByRole("button", { name: "Changes", exact: true }).waitFor({ state: "hidden" });
  await terminalRegion.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await review.waitFor({ state: "detached" });
  await page.locator(".xterm-rows").getByText("REVIEW_PTY_OK", { exact: true }).waitFor();
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

  if (process.platform !== "win32") {
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
    const terminalDivider = page.getByRole("separator", { name: "Resize terminal" });
    await terminalDivider.press("Shift+ArrowUp");
    await terminal.focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const enlarged = await ptySize(".pty-enlarged");
    assert.ok(Number.parseInt(enlarged, 10) > Number.parseInt(original, 10));
    await terminalDivider.press("Enter");
    await terminal.focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await ptySize(".pty-reset"), original);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 740));
    await page.waitForFunction(() => window.innerWidth <= 1000);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.notEqual(await ptySize(".pty-resized"), original);
  }

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
  assert.equal(await editQueued.inputValue(), draftQueued);
  await editQueued.fill(editedQueued);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await queuedRow(editedQueued).waitFor();
  await queueAction(discardedQueued, "Delete message");
  await queuedRow(discardedQueued).waitFor({ state: "detached" });
  await queuedRow(movedQueued).locator(".queued-message").dragTo(queuedRow(editedQueued).locator(".queued-row"), {
    sourcePosition: { x: 14, y: 15 }, targetPosition: { x: 14, y: 5 },
  });
  await queue.getByRole("listitem").nth(1).getByText(movedQueued, { exact: true }).waitFor();
  await queueAction(firstQueued, "Steer current run");
  await queuedRow(firstQueued).getByText("Steering", { exact: true }).waitFor();
  await app.evaluate(({ app }) => {
    const host = app.getAppMetrics().find(metric => metric.name === "Pideck workspace");
    if (!host) throw new Error("Workspace process was not found.");
    process.kill(host.pid, "SIGKILL");
  });
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
  await page.getByRole("button", { name: "Find in terminal" }).click();
  const previousOutput = page.getByRole("searchbox", { name: "Find in terminal output" });
  await previousOutput.fill("pty_ok");
  await match.filter({ hasText: /[1-9]\d* (?:of|results)/ }).waitFor({ timeout: 5_000 }).catch(async error => {
    const text = await match.allTextContents();
    const terminal = await page.locator(".xterm-rows").allTextContents();
    throw new Error("Recovered terminal search status was " + text.join(" ") + "\n" + terminal.join("\n"), { cause: error });
  });
  assert.equal((await command("session:list", { projectId }))[0].id, conversation.id);
  await prompt.fill("Resume this draft after reopening.");
  const savedWindow = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
  await app.close();
  app = undefined;

  const reopened = await launch();
  app = reopened.running;
  const reopenedPage = reopened.window;
  const restoredWindow = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
  assert.equal(restoredWindow.width, savedWindow.width);
  assert.equal(restoredWindow.height, savedWindow.height);
  if (process.platform === "darwin") {
    assert.equal(restoredWindow.x, savedWindow.x);
    assert.equal(restoredWindow.y, savedWindow.y);
  }
  const reopenedPrompt = reopenedPage.getByRole("textbox", { name: "Message Pideck" });
  await reopenedPrompt.waitFor();
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
  await reopenedPage.getByRole("article", { name: "Pideck" }).filter({ hasText: "Recovered after host restart." })
    .getByRole("button", { name: "Branch from here" }).click();
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
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, project);
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
  await restoredPage.getByRole("button", { name: "Review permissions", exact: true }).waitFor();
  await restoredPage.getByRole("complementary", { name: "Workspace navigation" })
    .getByRole("button", { name: "smoke-project", exact: true }).waitFor();
  const [readded] = await restoredPage.evaluate(() => window.pideck.invoke("project:list"));
  assert.notEqual(readded.id, projectId);
  assert.equal(readded.trusted, false);
  assert.deepEqual(await restoredPage.evaluate(id => window.pideck.invoke("session:list", { projectId: id }), readded.id), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(modelServer.failures, []);
  console.log("Packaged Electron verified: native menus, coding and host recovery, native PTY, and permanent workspace and session removal.");
} catch (error) {
  if (errors.length) console.error("Renderer errors:", errors);
  if (modelServer?.failures.length) console.error("Provider fixture errors:", modelServer.failures);
  throw error;
} finally {
  await app?.close();
  await modelServer?.close();
  await rm(temporary, { recursive: true, force: true });
}
