import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { _electron } from "playwright";
import { openSmokeProvider } from "./smoke-provider.mjs";

// Native macOS lifecycle acceptance against the packaged application. All files,
// conversations, shell jobs and model requests belong to a disposable profile.
// Notification show/click and Dock calls are intercepted below: this exercises
// the real Electron adapter, but deliberately does not claim OS delivery proof.
if (process.platform !== "darwin") throw new Error("This native lifecycle acceptance targets macOS.");
const executable = resolve(process.argv[2] ?? `release/mac-${process.arch}/Pideck.app/Contents/MacOS/Pideck`);
const evidence = resolve("output/playwright/native-review");
const temporary = await mkdtemp(join(tmpdir(), "pideck-native-"));
const profile = join(temporary, "profile");
const directory = join(temporary, "native-project");
const shellProfiles = join(temporary, "shell-profiles");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const results = { executable, notificationEvidence: "Electron adapter with intercepted show and synthetic click; OS delivery not asserted", checks: [] };
const limitation = message => { (results.limitations ??= []).push(message); };
let application;
let provider;
let lastPage;
const errors = [];

async function until(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}

async function observe(page) {
  lastPage = page;
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.pideck));
  return page;
}

async function menu(id) {
  await application.evaluate(({ BrowserWindow, Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item?.enabled) throw new Error(`Native menu ${id} is unavailable.`);
    const window = BrowserWindow.getAllWindows()[0];
    item.click({}, window, window?.webContents);
  }, id);
}

const command = (page, name, payload) => page.evaluate(([name, payload]) => window.pideck.invoke(name, payload), [name, payload]);

async function installNativeObservers() {
  await application.evaluate(({ app, dialog, Notification }) => {
    globalThis.__nativeSmoke = { notices: [], closed: [], badges: [], dialogs: [], response: 0 };
    const state = globalThis.__nativeSmoke;
    Notification.isSupported = () => true;
    Notification.getHistory = async () => [];
    Notification.remove = () => {};
    Notification.prototype.show = function () { state.notices.push(this); };
    Notification.prototype.close = function () { state.closed.push(this.id); };
    app.dock.setBadge = text => state.badges.push(text);
    dialog.showMessageBox = async (...args) => {
      state.dialogs.push(args.at(-1));
      return { response: state.response, checkboxChecked: false };
    };
    dialog.showErrorBox = (title, content) => { state.dialogs.push({ title, message: content }); };
  });
}

async function nativeState() {
  return application.evaluate(() => {
    const state = globalThis.__nativeSmoke;
    return { notices: state.notices.map(item => ({ id: item.id, title: item.title, body: item.body })),
      closed: state.closed, badges: state.badges, dialogs: state.dialogs };
  });
}

try {
  await Promise.all([mkdir(directory), mkdir(shellProfiles), mkdir(evidence, { recursive: true })]);
  await writeFile(join(shellProfiles, ".zshrc"), "PS1='native$ '\n");
  await writeFile(join(directory, "example.ts"), "export const result = 'before';\n");
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["add", "example.ts"], { cwd: directory });
  execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Native Smoke", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "Fixture"], { cwd: directory });
  provider = await openSmokeProvider();
  const launch = async () => {
    // The adapter show() below is intercepted, so no OS notification was
    // delivered to restore. Do not invoke the system's permission/history UI.
    await rm(join(profile, "notification-history"), { force: true });
    application = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`, "-SUEnableAutomaticChecks", "NO"],
      env: { ...process.env, SHELL: "/bin/zsh", ZDOTDIR: shellProfiles, AZURE_OPENAI_API_KEY: "pideck-smoke-key", AZURE_OPENAI_BASE_URL: provider.endpoint } });
    (results.processIds ??= []).push({ runner: process.pid, electron: application.process().pid });
    const page = await observe(await application.firstWindow());
    await installNativeObservers();
    return page;
  };
  let page = await launch();
  await page.getByRole("button", { name: /^Open (?:a project )?folder$/i }).waitFor();
  await application.evaluate(({ app }, directory) => app.emit("open-file", { preventDefault() {} }, directory), directory);
  await page.waitForFunction(() => Boolean(document.getElementById("prompt")));
  const [project] = await command(page, "project:list");
  assert.equal(project.directory, await realpath(directory));
  await application.evaluate(({ app }, directory) => app.emit("open-file", { preventDefault() {} }, directory), directory);
  await delay(200);
  assert.equal((await command(page, "project:list")).length, 1, "native folder open must reuse a project");
  await application.evaluate(({ app }, path) => app.emit("open-file", { preventDefault() {} }, path), join(directory, "example.ts"));
  await delay(150);
  assert.equal((await command(page, "project:list")).length, 1, "a native file event cannot become a project");
  results.checks.push("Finder/Dock directory open reuses projects and rejects files");

  const catalog = await command(page, "model:list");
  const model = catalog.models.find(item => item.provider === "azure" && item.id === "gpt-4.1");
  assert.equal(model?.configured, true);
  await page.getByRole("button", { name: "Model", exact: true }).click();
  const models = page.getByRole("region", { name: "Choose a model" });
  await models.getByRole("searchbox", { name: "Search models" }).fill("gpt-4.1");
  await models.getByRole("button", { name: /\bAzure\b/i }).filter({ has: page.getByText(model.name, { exact: true }) }).click();
  await page.getByRole("textbox", { name: "Message Pideck", exact: true }).fill("Update example.ts and verify the result.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Package stream verified with the real coding tools.", { exact: true }).waitFor();
  assert.match(await readFile(join(directory, "example.ts"), "utf8"), /'after'/);
  const [session] = await command(page, "session:list", { projectId: project.id });
  await until(() => application.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows()[0].getTitle().includes(title), session.title), "native session title");
  await page.locator("diffs-container").first().waitFor();
  await page.screenshot({ path: join(evidence, "coding-result.png") });
  results.checks.push("packaged coding through native pi-ai/Durable/tools and synchronized native window title");
  const named = await command(page, "session:rename", { projectId: project.id, sessionId: session.id, title: "Review backend" });

  const node = await application.evaluate(() => `${process.resourcesPath}/automation/node/bin/node`);
  const serverFile = join(directory, "server.cjs");
  const addressFile = join(directory, "server.json");
  const shellPidFile = join(directory, "shell.pid");
  const restoredFile = join(directory, "restored.txt");
  await writeFile(serverFile, `const http = require('node:http'); const fs = require('node:fs');
const server = http.createServer((_req, res) => res.end('native server alive'));
server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(addressFile)}, JSON.stringify({ port: server.address().port, pid: process.pid })));
`);
  await menu("toggle-terminal");
  const terminal = await command(page, "terminal:open", { projectId: project.id, cols: 80, rows: 24 });
  await command(page, "terminal:input", { projectId: project.id, terminalId: terminal.terminalId,
    data: `NATIVE_VALUE=retained; printf '%s' $$ > ${quote(shellPidFile)}; ${quote(node)} ${quote(serverFile)}\r` });
  await until(async () => { try { return Boolean(JSON.parse(await readFile(addressFile, "utf8")).port); } catch { return false; } }, "terminal dev server starts");
  const server = JSON.parse(await readFile(addressFile, "utf8"));
  const shellPid = await readFile(shellPidFile, "utf8");
  assert.equal(await fetch(`http://127.0.0.1:${server.port}`).then(response => response.text()), "native server alive");
  async function declineQuit(message) {
    const before = (await nativeState()).dialogs.length;
    await application.evaluate(({ app }) => {
      globalThis.__nativeSmoke.response = 0;
      app.quit();
      app.quit();
    });
    await until(async () => (await nativeState()).dialogs.length > before, message);
    await delay(100);
    const dialogs = (await nativeState()).dialogs;
    assert.equal(dialogs.length, before + 1, "repeated Quit must share one status read and confirmation");
    assert.equal(dialogs.at(-1).message, message);
    assert.deepEqual(dialogs.at(-1).buttons, ["Keep Working", "Quit"]);
    assert.equal(dialogs.at(-1).defaultId, 0);
    assert.equal(dialogs.at(-1).cancelId, 0);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  }
  await declineQuit("Quit while a terminal may be busy?");
  assert.equal(await fetch(`http://127.0.0.1:${server.port}`).then(response => response.text()), "native server alive");
  assert.equal((await command(page, "terminal:open", { projectId: project.id, cols: 80, rows: 24 })).terminalId, terminal.terminalId);
  results.checks.push("AI-idle quit detects a foreground terminal server; Keep Working and repeated Quit preserve its process and shell");
  await delay(700);
  const noticesBeforeClose = (await nativeState()).notices.length;
  await command(page, "chat:send", { projectId: project.id, sessionId: session.id, requestId: randomUUID(),
    text: "Queue hold CLOSE", model: { provider: model.provider, id: model.id }, thinking: "off" });
  await provider.waitForGate("Queue hold CLOSE");
  const streamingRequests = provider.requests.length;
  await application.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
  await delay(300);
  assert.equal(provider.requests.length, streamingRequests, "wake during streaming cannot duplicate the model request");
  await application.evaluate(({ BrowserWindow }) => new Promise(resolve => {
    const window = BrowserWindow.getAllWindows()[0];
    window.once("closed", resolve);
    window.close();
  }));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
  assert.equal(await fetch(`http://127.0.0.1:${server.port}`).then(response => response.text()), "native server alive");
  provider.releaseGate("Queue hold CLOSE");
  await until(async () => (await nativeState()).notices.length > noticesBeforeClose, "windowless completion reaches native notification adapter");
  const unread = await nativeState();
  assert.ok(unread.badges.some(value => value === "1"), "unread completion reaches the Dock adapter");
  const reminder = unread.notices.at(-1);
  assert.equal(reminder.title, `${project.name} · ${named.title}`);
  assert.equal(reminder.body, "Work finished. Open to view the result.");
  assert.ok([directory, "example.ts", "Queue hold CLOSE", "current run finished"].every(text =>
    !`${reminder.title}\n${reminder.body}`.includes(text)), "notification does not expose paths, prompts or result text");
  results.checks.push("windowless notification includes the project and explicit session title with generic status");
  const opened = application.waitForEvent("window");
  results.beforeSyntheticClick = await application.evaluate(({ app, BrowserWindow }) => ({ hidden: app.isHidden(),
    focused: BrowserWindow.getAllWindows().map(window => window.isFocused()) }));
  await application.evaluate(({ app }) => {
    // A real notification click activates its application in AppKit. A plain
    // EventEmitter.emit cannot supply that OS step, so reproduce it explicitly.
    app.focus({ steal: true });
    globalThis.__nativeSmoke.notices.at(-1).emit("click");
  });
  page = await observe(await opened);
  await page.getByText("Queue hold CLOSE: current run finished.", { exact: true }).waitFor();
  results.afterSyntheticClick = await application.evaluate(({ BrowserWindow }) => ({ focused: BrowserWindow.getAllWindows()[0].isFocused() }));
  results.afterSyntheticClick.documentFocused = await page.evaluate(() => document.hasFocus());
  if (!results.afterSyntheticClick.focused) {
    const taskId = Number(unread.notices.at(-1).id.split(":").at(-1));
    await assert.rejects(command(page, "session:read-activity", { projectId: project.id, sessionId: session.id, taskId }), /View the result/);
    assert.equal((await nativeState()).badges.at(-1), "1", "background read cannot clear a native reminder");
    results.checks.push("native read guard rejects a background window even when renderer document.hasFocus is true");
    limitation("OS activation did not grant the isolated acceptance window native focus; read-clear below uses an explicit adapter-only focused-window projection");
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      globalThis.__nativeSmoke.actualFocus = window.isFocused;
      window.isFocused = () => true;
    });
    try {
      await command(page, "session:read-activity", { projectId: project.id, sessionId: session.id, taskId });
    } finally {
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].isFocused = globalThis.__nativeSmoke.actualFocus;
      });
    }
    results.readClearEvidence = "adapter-only simulated native focus; native background rejection verified separately";
  } else results.readClearEvidence = "real native focus and renderer visible-result acknowledgement";
  await until(async () => (await nativeState()).badges.at(-1) === "", "reading the result clears unread Dock badge");
  await menu("toggle-terminal");
  const reattached = await command(page, "terminal:open", { projectId: project.id, cols: 80, rows: 24 });
  assert.equal(reattached.terminalId, terminal.terminalId);
  assert.equal(reattached.exited, false);
  await command(page, "terminal:input", { projectId: project.id, terminalId: terminal.terminalId, data: "\x03" });
  await command(page, "terminal:input", { projectId: project.id, terminalId: terminal.terminalId,
    data: `printf '%s:%s' $$ "$NATIVE_VALUE" > ${quote(restoredFile)}\r` });
  await until(async () => { try { return (await readFile(restoredFile, "utf8")) === `${shellPid}:retained`; } catch { return false; } }, "same shell PID and environment after reopen");
  await page.getByRole("region", { name: "Project terminal" }).getByText("Shell running", { exact: true }).waitFor();
  await page.getByRole("region", { name: "Project terminal" }).locator(".xterm-rows").waitFor();
  await page.screenshot({ path: join(evidence, "terminal-reopened.png") });
  results.checks.push("closed window retains shell and dev server; completion opens its session; same PID/environment reattach; read clears badge");

  await application.evaluate(({ BrowserWindow }) => new Promise(resolve => {
    const window = BrowserWindow.getAllWindows()[0];
    window.once("minimize", resolve);
    window.minimize();
  }));
  await application.evaluate(({ app }) => app.emit("second-instance", {}, [], ""));
  let restoredWindow;
  await until(async () => {
    restoredWindow = await application.evaluate(({ app, BrowserWindow, powerMonitor }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { minimized: window.isMinimized(), focused: window.isFocused(), visible: window.isVisible(), hidden: app.isHidden(),
        idle: powerMonitor.getSystemIdleState(1) };
    });
    return !restoredWindow.minimized && restoredWindow.visible;
  }, "second instance restores minimized window").catch(error => {
    throw new Error(`${error.message}: ${JSON.stringify(restoredWindow)}`);
  });
  const countBeforeResume = provider.requests.length;
  await application.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
  await page.getByRole("textbox", { name: "Message Pideck", exact: true }).waitFor();
  await delay(400);
  assert.equal(provider.requests.length, countBeforeResume, "resume cannot submit or replay model/tool work");
  const afterResume = await command(page, "terminal:open", { projectId: project.id, cols: 80, rows: 24 });
  assert.equal(afterResume.terminalId, terminal.terminalId, "resume does not rebuild a healthy shell");
  if (restoredWindow.focused) results.checks.push("second-instance restores and focuses a minimized window");
  else limitation(`Window restored and became visible, but OS focus was not granted to the isolated acceptance application (idle=${restoredWindow.idle})`);
  results.checks.push("native resume signal resynchronizes without re-submitting work or rebuilding shell");

  await command(page, "terminal:input", { projectId: project.id, terminalId: terminal.terminalId, data: "echo unfinished" });
  await declineQuit("Quit while a terminal may be busy?");
  const unfinished = await command(page, "terminal:open", { projectId: project.id, cols: 80, rows: 24 });
  assert.equal(unfinished.terminalId, terminal.terminalId);
  assert.match(unfinished.data, /echo unfinished/);
  await command(page, "terminal:input", { projectId: project.id, terminalId: terminal.terminalId, data: "\u0003" });
  await delay(150);
  results.checks.push("AI-idle quit protects unfinished terminal input without replacing the shell");

  await command(page, "chat:send", { projectId: project.id, sessionId: session.id, requestId: randomUUID(),
    text: "Queue hold QUIT", model: { provider: model.provider, id: model.id }, thinking: "off" });
  await provider.waitForGate("Queue hold QUIT");
  const dialogStart = (await nativeState()).dialogs.length;
  await application.evaluate(({ app }) => { globalThis.__nativeSmoke.response = 0; app.quit(); });
  await until(async () => (await nativeState()).dialogs.length > dialogStart, "active work quit confirmation");
  assert.deepEqual((await nativeState()).dialogs.at(-1).buttons, ["Keep Working", "Quit"]);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  provider.releaseGate("Queue hold QUIT");
  await page.getByText("Queue hold QUIT: current run finished.", { exact: true }).waitFor();
  const dialogsAfterCancel = (await nativeState()).dialogs.length;
  const quitDiagnostics = join(temporary, "idle-quit.json");
  await application.evaluate(({ app }, path) => app.once("will-quit", () => {
    process.getBuiltinModule("node:fs").writeFileSync(path, JSON.stringify(globalThis.__nativeSmoke.dialogs));
  }), quitDiagnostics);
  const closing = application.waitForEvent("close");
  await application.evaluate(({ app }) => app.quit());
  await closing;
  application = undefined;
  assert.equal(JSON.parse(await readFile(quitDiagnostics, "utf8")).length, dialogsAfterCancel, "idle quit has no confirmation");
  results.checks.push("active quit Keep Working keeps the task alive; subsequent quit with a verified idle native shell completes without confirmation");
  assert.ok(dialogsAfterCancel > dialogStart);
  await until(async () => { try { process.kill(Number(shellPid), 0); return false; } catch (error) { return error.code === "ESRCH"; } }, "quit tears down terminal process");
  page = await launch();
  await page.getByText("Queue hold QUIT: current run finished.", { exact: true }).waitFor();
  assert.equal((await nativeState()).notices.length, 0, "relaunch does not replay an already read completion notification");
  await command(page, "chat:send", { projectId: project.id, sessionId: session.id, requestId: randomUUID(),
    text: "Queue hold STOP", model: { provider: model.provider, id: model.id }, thinking: "off" });
  await provider.waitForGate("Queue hold STOP");
  const acceptedDiagnostics = join(temporary, "active-quit.json");
  await application.evaluate(({ app }, path) => {
    globalThis.__nativeSmoke.response = 1;
    app.once("will-quit", () => process.getBuiltinModule("node:fs").writeFileSync(path, JSON.stringify(globalThis.__nativeSmoke.dialogs)));
  }, acceptedDiagnostics);
  const acceptedClose = application.waitForEvent("close");
  await application.evaluate(({ app }) => app.quit());
  await acceptedClose;
  application = undefined;
  assert.deepEqual(JSON.parse(await readFile(acceptedDiagnostics, "utf8")).at(-1).buttons, ["Keep Working", "Quit"]);
  provider.releaseGate("Queue hold STOP");
  page = await launch();
  await page.getByText("Queue hold STOP: current run finished.", { exact: true }).waitFor();
  results.checks.push("accepting Quit stops active work; cold relaunch recovers the interrupted Durable task");
  const unknownShell = await command(page, "terminal:open", { projectId: project.id, cols: 80, rows: 24 });
  await command(page, "terminal:input", { projectId: project.id, terminalId: unknownShell.terminalId,
    data: "exec /bin/sh\r" });
  await delay(200);
  await declineQuit("Quit while a terminal may be busy?");
  results.checks.push("a shell without reliable prompt integration requires confirmation even when AI work is idle");
  await page.screenshot({ path: join(evidence, "relaunch.png") });
  assert.deepEqual(provider.failures, []);
  assert.deepEqual(errors, []);
  results.checks.push("cold relaunch restores the conversation without duplicate completion notifications");
  results.passed = true;
  results.providerRequests = provider.requests.length;
  await writeFile(join(evidence, "acceptance.json"), JSON.stringify(results, null, 2) + "\n");
  await Promise.all(["failure.json", "failure.png"].map(name => rm(join(evidence, name), { force: true })));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  const failure = { error: error.message, checks: results.checks };
  if (application) {
    failure.native = await application.evaluate(({ BrowserWindow, powerMonitor, app }) => ({
      idle: powerMonitor.getSystemIdleState(1), hidden: app.isHidden(),
      windows: BrowserWindow.getAllWindows().map(window => ({ focused: window.isFocused(), minimized: window.isMinimized(), visible: window.isVisible(), title: window.getTitle() })),
    })).catch(() => undefined);
    failure.adapter = await nativeState().catch(() => undefined);
    if (lastPage && !lastPage.isClosed()) {
      failure.renderer = await lastPage.evaluate(() => ({ focus: document.hasFocus(), visibility: document.visibilityState, title: document.title })).catch(() => undefined);
      await lastPage.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
    }
  }
  await writeFile(join(evidence, "failure.json"), JSON.stringify(failure, null, 2) + "\n");
  throw error;
} finally {
  if (application) {
    await application.evaluate(() => { if (globalThis.__nativeSmoke) globalThis.__nativeSmoke.response = 1; }).catch(() => {});
    await application.close().catch(() => {});
  }
  await provider?.close();
  await rm(temporary, { recursive: true, force: true });
}
