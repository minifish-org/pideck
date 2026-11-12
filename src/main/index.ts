import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, powerMonitor, protocol, safeStorage, session, shell } from "electron";
import type { IpcMainInvokeEvent, MessageBoxOptions } from "electron";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eventChannel, invokeChannel, menuStateChannel, type RemovalTarget } from "../shared/transport";
import { safeAuthUrl } from "../host/auth-flows";
import { CredentialVault } from "./credentials";
import { HostClient } from "./host-client";
import { installDesktopMenu, isMenuState } from "./menu";
import { checkForUpdate, releasesPage } from "./update-check";
import { isCommand, validPayload } from "./validation";
import { minimumWindow, openWindowState } from "./window-state";
import { appearanceBackground, appearanceDocument, openAppearance } from "./appearance";
import { externalMessageUrl } from "../shared/message-links";
import type { DesktopContext, DesktopNavigation, Project, Selection, Session } from "../shared/api";
import { projectArguments, QuitGuard, workspaceTitle } from "./native-workspace";
import { createNativeNotifications } from "./native-notifications";
import { activityNotificationLaunchId } from "./activity-notifications";
import { loadMacUpdater, type MacUpdater, type NativeUpdateEvent } from "./mac-updater";
import { UpdateInstallation } from "./update-install";
import { RendererRecovery } from "./renderer-recovery";

const appUrl = "pideck://app/index.html";
const root = fileURLToPath(new URL("../renderer", import.meta.url));
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

protocol.registerSchemesAsPrivileged([
  { scheme: "pideck", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
app.enableSandbox();

let mainWindow: BrowserWindow | undefined;
let desktopMenu: ReturnType<typeof installDesktopMenu> | undefined;
let windowState: Awaited<ReturnType<typeof openWindowState>>;
let appearance: Awaited<ReturnType<typeof openAppearance>>;
let owner = 0;
let host: HostClient | undefined;
let exiting = false;
let shutdownComplete = false;
let shuttingDown = false;
let quitPending = false;
let quitGuard: QuitGuard | undefined;
let desktopReady = false;
let locked = false;
let contextVersion = 0;
let navigationId = 0;
let visibleContext: DesktopContext = { viewing: false };
let pendingNavigation: DesktopNavigation | null = null;
let reminders: ReturnType<typeof createNativeNotifications> | undefined;
let notificationLaunch: string | undefined;
const pendingFolders: string[] = [];
let openingFolders = false;
let macUpdater: MacUpdater | undefined;
let updaterStartupError: unknown;
let updateInstallation: UpdateInstallation | undefined;
let preparingUpdate = false;
let pendingUpdateInstall = false;

function refreshUpdateMenu() {
  const item = Menu.getApplicationMenu()?.getMenuItemById("check-for-updates");
  if (!item || process.platform !== "darwin" || !app.isPackaged) return;
  const status = macUpdater?.status();
  item.label = pendingUpdateInstall ? "Restart and Update…"
    : status === "checking" ? "Cancel Update Check"
    : status === "showing" ? "Show Software Update…"
    : "Check for Updates…";
  item.enabled = !exiting && !preparingUpdate && (pendingUpdateInstall || status !== "busy");
}

function nativeUpdateEvent(event: NativeUpdateEvent) {
  if (shuttingDown) return;
  if (event.type === "install-requested") {
    pendingUpdateInstall = true;
    void updateInstallation?.request();
  } else if (event.type === "aborted") {
    pendingUpdateInstall = false;
    void updateInstallation?.aborted();
  }
  refreshUpdateMenu();
}

function revealWindow() {
  if (!host || !windowState || exiting) return;
  const window = mainWindow;
  if (!window || window.isDestroyed()) openWindow(true);
  else {
    if (window.isMinimized()) window.restore();
    window.show();
    if (process.platform === "darwin") app.focus({ steal: true });
    window.focus();
  }
}

function navigate(project: Project, session?: Session, showResult = false) {
  const navigation: DesktopNavigation = { id: ++navigationId, project, session, ...(showResult ? { showResult: true } : {}) };
  pendingNavigation = navigation;
  revealWindow();
  if (desktopReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(eventChannel, { type: "desktop:navigate", navigation });
  }
}

async function drainFolders() {
  if (!host || !windowState || openingFolders || exiting) return;
  openingFolders = true;
  try {
    while (pendingFolders.length && !exiting) {
      const directory = pendingFolders.shift()!;
      try {
        // Finder can also send ordinary files. Opening a project never launches
        // a file or guesses its parent directory.
        if (!(await stat(directory)).isDirectory()) continue;
        const project = await host.request(0, "project:add", { directory });
        if (!exiting) navigate(project);
      } catch {
        if (!exiting) dialog.showErrorBox("Could not open folder", "The project folder is unavailable. Check that it still exists and that you can access it.");
      }
    }
  } finally { openingFolders = false; }
}

function queueFolders(directories: readonly string[]) {
  for (const directory of directories) if (!pendingFolders.includes(directory)) pendingFolders.push(directory);
  void drainFolders();
}

async function openResult(selection: Selection) {
  if (!host || exiting) return;
  // Revalidate at the host boundary; a stale OS notification cannot recreate
  // a removed project/session or navigate to a different session.
  const project = (await host.request(0, "project:list", undefined)).find(item => item.id === selection.projectId);
  if (!project || exiting) return;
  const session = (await host.request(0, "session:list", { projectId: project.id })).find(item => item.id === selection.sessionId);
  if (session && !exiting) navigate(project, session, true);
}

function shutdownHost() {
  if (exiting || !host) return;
  const client = host;
  exiting = true;
  if (mainWindow) windowState.capture(mainWindow);
  const finish = () => {
    reminders?.dispose();
    appearance.dispose();
    shutdownComplete = true;
    app.quit();
  };
  const closing = client.close();
  const pending = [closing, windowState.flush(), appearance.flush()] as const;
  if (!macUpdater) {
    void Promise.allSettled(pending).finally(finish);
    return;
  }
  // Sparkle may have a user-approved install waiting for ordinary app quit.
  // Termination is therefore also an installation boundary, even when this
  // particular Quit was not initiated by the updater's relaunch callback.
  void Promise.all(pending).then(([closed]) => {
    if (closed.status !== "graceful") throw new Error("The workspace could not close safely. Pideck will stay open.");
    finish();
  }).catch(async error => {
    exiting = false;
    shutdownComplete = false;
    let message = error instanceof Error ? error.message : "The workspace could not close safely.";
    try { await client.reopenAfterClose(); }
    catch (recovery) { message += `\n\n${recovery instanceof Error ? recovery.message : "The workspace could not reopen."}`; }
    revealWindow();
    refreshUpdateMenu();
    dialog.showErrorBox("Pideck could not close safely", message);
  });
}

function ownsFrame(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, window: BrowserWindow): boolean {
  return event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame?.url === appUrl;
}

async function showUpdateCheck(window?: BrowserWindow) {
  if (process.platform === "darwin" && app.isPackaged) {
    if (pendingUpdateInstall) await updateInstallation?.request();
    else if (macUpdater?.status() === "checking") macUpdater.cancelCheck();
    else if (macUpdater) macUpdater.check();
    else dialog.showErrorBox("Updates could not start", updaterStartupError instanceof Error
      ? updaterStartupError.message : "The installed updater is unavailable. Reinstall Pideck from its official release.");
    refreshUpdateMenu();
    return;
  }
  const version = app.getVersion();
  const update = await checkForUpdate(version, (input, init) => net.fetch(input, init));
  if (exiting) return;
  let options: MessageBoxOptions;
  let releaseUrl: string | undefined;
  switch (update.status) {
    case "available":
      releaseUrl = update.releaseUrl;
      options = { message: "A Pideck update is available", detail: `Version ${update.version} is available. You are running ${version}.`,
        buttons: ["View Release", "Close"] };
      break;
    case "current":
      options = { message: "Pideck is up to date", detail: `You are running version ${version}.`, buttons: ["OK"] };
      break;
    case "empty":
      options = { message: "No stable Pideck release is available", detail: `You are running version ${version}.`, buttons: ["OK"] };
      break;
    case "error":
      if (update.reason === "unavailable") releaseUrl = releasesPage;
      options = { type: "warning", message: "Could not check for updates",
        detail: releaseUrl ? "GitHub did not make Pideck’s releases available. Check access in your signed-in browser."
          : update.reason === "response" ? "GitHub returned an unexpected release response. Try again later."
          : "The release check could not reach GitHub or complete the request. Try again later.",
        buttons: releaseUrl ? ["Open Releases", "Close"] : ["OK"] };
      break;
  }
  const box: MessageBoxOptions = { type: "info", title: "Check for Updates", defaultId: 0, cancelId: releaseUrl ? 1 : 0,
    noLink: true, ...options };
  const { response } = await (window && !window.isDestroyed() ? dialog.showMessageBox(window, box) : dialog.showMessageBox(box));
  if (response === 0 && releaseUrl && !exiting) await shell.openExternal(releaseUrl);
}

function openWindow(activate = false) {
  const initial = windowState.options();
  const window = new BrowserWindow({
    ...initial.bounds,
    minWidth: minimumWindow.width,
    minHeight: minimumWindow.height,
    backgroundColor: appearanceBackground(appearance.get()),
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 20, y: 21 },
      // Match the renderer toolbar so AppKit centers its controls within it.
      titleBarOverlay: { height: 56 },
    } : {}),
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  mainWindow = window;
  desktopReady = false;
  visibleContext = { viewing: false };
  contextVersion++;
  desktopMenu?.attach(window);
  let windowOwner = ++owner;
  const windowId = window.webContents.id;

  const retire = (preserveQueueEdits = false) => {
    void host?.request(windowOwner, "owner:close", { preserveQueueEdits }, windowId).catch(() => {});
  };
  window.webContents.on("did-navigate", () => {
    desktopReady = false;
    visibleContext = { viewing: false };
    contextVersion++;
    retire(true);
    windowOwner = ++owner;
  });
  const recovery = new RendererRecovery();
  let recovering = false;
  window.webContents.on("render-process-gone", () => {
    desktopReady = false;
    visibleContext = { viewing: false };
    contextVersion++;
    retire(true);
    if (recovering || exiting || shuttingDown || window.isDestroyed()) return;
    recovering = true;
    void (async () => {
      if (!recovery.automatic()) {
        const { response } = await dialog.showMessageBox(window, {
          type: 'error', title: 'Pideck', message: 'The interface stopped unexpectedly.',
          detail: 'Your workspace is still running. Recover the interface without resending messages or terminal input.',
          buttons: ['Recover Interface', 'Close Window'], defaultId: 0, cancelId: 1, noLink: true,
        });
        if (exiting || window.isDestroyed()) return;
        if (response !== 0) { window.close(); return; }
        recovery.retry();
        recovery.automatic();
      }
      if (!exiting && !window.isDestroyed()) await window.loadURL(appUrl);
    })().catch(() => {
      if (!exiting && !window.isDestroyed()) dialog.showErrorBox('Pideck', 'The interface could not be recovered. Close and reopen the window to try again.');
    }).finally(() => { recovering = false; });
  });
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-frame-navigate", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const capture = () => windowState.capture(window);
  window.on("move", capture);
  window.on("resize", capture);
  window.on("maximize", capture);
  window.on("unmaximize", capture);
  window.on("close", () => { capture(); void windowState.flush(); });
  window.once("closed", () => {
    retire();
    if (mainWindow === window) {
      mainWindow = undefined;
      desktopReady = false;
      visibleContext = { viewing: false };
      contextVersion++;
    }
  });
  window.once("ready-to-show", () => {
    window.show();
    if (initial.maximized) window.maximize();
    if (activate) {
      if (process.platform === "darwin") app.focus({ steal: true });
      window.focus();
    }
  });
  // The validated workspace context, not HTML/model output, owns the OS title.
  window.on("page-title-updated", event => event.preventDefault());
  void window.loadURL(appUrl).catch(() => {
    if (!window.isDestroyed()) {
      dialog.showErrorBox("Pideck", "The desktop interface could not be loaded.");
      window.destroy();
    }
  });
}

async function initialize() {
  const dataDir = app.getPath("userData");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  appearance = await openAppearance(dataDir, nativeTheme);
  appearance.subscribe(state => {
    desktopMenu?.refreshAppearance();
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;
    window.setBackgroundColor(appearanceBackground(state));
    window.webContents.send(eventChannel, { type: "appearance:changed", appearance: state });
  });
  protocol.handle("pideck", async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "app" || request.method !== "GET") return new Response(null, { status: 404 });
      const path = resolve(root, "." + decodeURIComponent(url.pathname));
      if (!path.startsWith(root + sep)) return new Response(null, { status: 404 });
      const file = await net.fetch(pathToFileURL(path).href);
      const headers = new Headers(file.headers);
      headers.set("Content-Security-Policy", csp);
      headers.set("X-Content-Type-Options", "nosniff");
      if (url.pathname === "/index.html" && file.ok) {
        headers.delete("Content-Length");
        headers.set("Cache-Control", "no-store");
        return new Response(appearanceDocument(await file.text(), appearance.get()), { status: file.status, headers });
      }
      return new Response(file.body, { status: file.status, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  session.defaultSession.on("will-download", event => event.preventDefault());

  windowState = await openWindowState(dataDir);
  locked = powerMonitor.getSystemIdleState(1) === "locked";
  reminders = createNativeNotifications({
    isViewing: selection => !locked && Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()
      && mainWindow.isVisible() && !mainWindow.isMinimized() && visibleContext.viewing
      && visibleContext.projectId === selection.projectId && visibleContext.sessionId === selection.sessionId),
    open: openResult,
  });
  if (notificationLaunch) reminders.activate(notificationLaunch);
  await reminders.ready;
  const vault = new CredentialVault(dataDir, safeStorage);
  const targetOS = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : process.platform;
  const automationDirectory = app.isPackaged ? join(process.resourcesPath, "automation")
    : fileURLToPath(new URL(`../../release/automation-assets/${targetOS}-${process.arch}/`, import.meta.url));
  const client = new HostClient(dataDir, vault, (target, event) => {
    if (target === owner && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(eventChannel, event);
  }, () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(eventChannel, { type: "host:restart" });
  }, message => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(eventChannel, { type: "host:disconnected", message });
  }, automationDirectory, (items, baseline) => reminders?.update(items, { baseline }));
  host = client;
  client.start();
  const menu = installDesktopMenu(revealWindow, showUpdateCheck, appearance);
  desktopMenu = menu;
  if (process.platform === "darwin") {
    app.dock?.setMenu(Menu.buildFromTemplate([{ label: "Open Folder…", click: () => menu.openProject() }]));
  }
  ipcMain.on(menuStateChannel, (event, state: unknown) => {
    const window = mainWindow;
    if (window && !window.isDestroyed() && ownsFrame(event, window) && isMenuState(state)) menu.update(window, state);
  });

  async function confirmRemoval(window: BrowserWindow, requestOwner: number, target: RemovalTarget) {
    const plan = await client.request(requestOwner, "removal:plan", target);
    if (window.isDestroyed() || requestOwner !== owner) return null;
    if (plan.blockingBranches.length) return { blockingBranches: plan.blockingBranches };
    const count = plan.sessionCount;
    const scope = target.sessionId ? "this session" : count
      ? `this workspace and its ${count} ${count === 1 ? "session" : "sessions"}` : "this workspace";
    const result = await dialog.showMessageBox(window, {
      type: "warning",
      buttons: ["Cancel", "Remove"],
      defaultId: 0,
      cancelId: 0,
      message: `Remove “${plan.name}”?`,
      detail: `Pideck will stop active work in ${scope} and permanently remove its saved data.\n\nFiles in ${plan.directory} will be kept.`,
    });
    if (result.response !== 1 || window.isDestroyed() || requestOwner !== owner) return null;
    const removed = await client.request(requestOwner, "removal:execute", { ...target, scope: plan.scope });
    if (pendingNavigation?.project.id === target.projectId
      && (!target.sessionId || (pendingNavigation.session && removed.sessionIds.includes(pendingNavigation.session.id)))) {
      pendingNavigation = null;
    }
    return removed;
  }

  let choosingProject = false;
  ipcMain.handle(invokeChannel, async (event, command: unknown, payload: unknown) => {
    const window = mainWindow;
    const requestOwner = owner;
    if (!window || window.isDestroyed() || !ownsFrame(event, window)) throw new Error("Unauthorized window.");
    if (!isCommand(command)) throw new Error("Invalid workspace request.");
    if (exiting || preparingUpdate) throw new Error("Pideck is preparing to restart. Your draft stays saved.");

    if (command === "host:recover") {
      if (!validPayload(command, payload)) throw new Error("Invalid workspace recovery request.");
      return client.recover();
    }

    if (command === "desktop:ready") {
      if (!validPayload(command, payload)) throw new Error("Invalid desktop request.");
      desktopReady = true;
      const target = pendingNavigation;
      if (!target) return null;
      const project = (await client.request(requestOwner, "project:list", undefined)).find(item => item.id === target.project.id);
      const selected = project && target.session
        ? (await client.request(requestOwner, "session:list", { projectId: project.id })).find(item => item.id === target.session!.id) : undefined;
      if (!project || (target.session && !selected)) {
        if (pendingNavigation?.id === target.id) pendingNavigation = null;
        return null;
      }
      if (window.isDestroyed() || requestOwner !== owner) return null;
      return { ...target, project, session: selected };
    }
    if (command === "desktop:context") {
      if (!validPayload(command, payload)) throw new Error("Invalid desktop context.");
      const version = ++contextVersion;
      const project = payload.projectId
        ? (await client.request(requestOwner, "project:list", undefined)).find(item => item.id === payload.projectId) : undefined;
      const selected = project && payload.sessionId
        ? (await client.request(requestOwner, "session:list", { projectId: project.id })).find(item => item.id === payload.sessionId) : undefined;
      if ((payload.projectId && !project) || (payload.sessionId && !selected)) throw new Error("This workspace is no longer available.");
      if (window.isDestroyed() || requestOwner !== owner || version !== contextVersion) return;
      visibleContext = payload;
      window.setTitle(workspaceTitle(project, selected));
      const pending = pendingNavigation;
      if (pending && pending.project.id === project?.id
        && (!pending.session || pending.session.id === selected?.id)) pendingNavigation = null;
      return;
    }

    if (command === "appearance:get") {
      if (!validPayload(command, payload)) throw new Error("Invalid appearance request.");
      return appearance.get();
    }

    if (command === "clipboard:write") {
      if (!validPayload(command, payload)) throw new Error("Invalid clipboard text.");
      clipboard.writeText(payload.text);
      return;
    }
    if (command === "link:open-external") {
      if (!validPayload(command, payload)) throw new Error("This link could not be opened safely.");
      const url = externalMessageUrl(payload.url);
      if (!url) throw new Error("This link could not be opened safely.");
      await shell.openExternal(url.href);
      return;
    }
    if (!validPayload(command, payload)) throw new Error("Invalid workspace request.");

    if (command === "session:read-activity" && (locked || !window.isFocused() || !window.isVisible() || window.isMinimized())) {
      throw new Error("View the result to mark it as read.");
    }

    if (command === "project:open") {
      if (choosingProject) return null;
      choosingProject = true;
      try {
        const result = await dialog.showOpenDialog(window, { title: "Open a project", properties: ["openDirectory"] });
        const [directory] = result.filePaths;
        if (result.canceled || !directory || exiting || window.isDestroyed()
          || requestOwner !== owner || !ownsFrame(event, window)) return null;
        return await client.request(requestOwner, "project:add", { directory });
      } finally {
        choosingProject = false;
      }
    }
    if (command === "project:remove") {
      if (!validPayload(command, payload)) throw new Error("Invalid workspace request.");
      return confirmRemoval(window, requestOwner, { projectId: payload.projectId });
    }
    if (command === "session:remove") {
      if (!validPayload(command, payload)) throw new Error("Invalid workspace request.");
      return confirmRemoval(window, requestOwner, { projectId: payload.projectId, sessionId: payload.sessionId });
    }
    if (command === "model:auth-copy" && validPayload(command, payload)) {
      const code = await client.request(requestOwner, command, payload);
      if (window.isDestroyed() || requestOwner !== owner) throw new Error("This window has closed.");
      clipboard.writeText(code);
      return;
    }
    if (command === "model:auth-open" && validPayload(command, payload)) {
      const url = safeAuthUrl(await client.request(requestOwner, command, payload));
      if (window.isDestroyed() || requestOwner !== owner) throw new Error("This window has closed.");
      if (!url) throw new Error("This provider link could not be opened safely.");
      await shell.openExternal(url.href);
      return;
    }
    return client.request(requestOwner, command, payload, window.webContents.id);
  });

  quitGuard = new QuitGuard(async () => (await client.request(0, "host:status", undefined)).active, async () => {
    const options: MessageBoxOptions = { type: "warning", message: "Quit while work is running?",
      detail: "Running work and terminal commands will stop. Your saved conversations will be available when you reopen Pideck.",
      buttons: ["Keep Working", "Quit"], defaultId: 0, cancelId: 0, noLink: true };
    const window = mainWindow;
    const result = await (window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
    return result.response === 1;
  });
  updateInstallation = new UpdateInstallation({
    seal() { preparingUpdate = true; refreshUpdateMenu(); },
    unseal() {
      if (shuttingDown) return;
      preparingUpdate = false;
      exiting = false;
      shutdownComplete = false;
      refreshUpdateMenu();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(eventChannel, { type: "host:resume" });
    },
    async confirm() {
      const work = await client.request(0, "host:status", undefined);
      if (!work.active && !work.terminalCount) return true;
      const options: MessageBoxOptions = { type: "warning", message: "Restart while work is open?",
        detail: "AI work and open terminal shells will stop. Your conversations, queued edits and drafts stay saved.",
        buttons: ["Keep Working", "Restart and Update"], defaultId: 0, cancelId: 0, noLink: true };
      const window = mainWindow;
      if (window && !window.isDestroyed()) revealWindow();
      const result = await (window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
      return result.response === 1;
    },
    async flush() {
      if (mainWindow && !mainWindow.isDestroyed()) windowState.capture(mainWindow);
      await Promise.all([windowState.flush(), appearance.flush()]);
    },
    closeHost: () => client.close(),
    async recover() {
      if (shuttingDown) return;
      exiting = false;
      shutdownComplete = false;
      await client.reopenAfterClose();
      revealWindow();
    },
    install() {
      if (shuttingDown) return false;
      // Sparkle may synchronously ask AppKit to terminate the application.
      // Its native installation handler is released only after a clean host exit.
      exiting = true;
      shutdownComplete = true;
      return macUpdater?.resumeInstall() ?? false;
    },
    failed(error) {
      if (shuttingDown) return;
      dialog.showErrorBox("The update was not installed", error instanceof Error ? error.message : "The workspace could not close safely. Try again.");
    },
  });
  powerMonitor.on("lock-screen", () => { locked = true; });
  powerMonitor.on("unlock-screen", () => {
    locked = false;
    reminders?.refreshBadge();
    if (!exiting) mainWindow?.webContents.send(eventChannel, { type: "host:resume" });
  });
  powerMonitor.on("resume", () => {
    if (exiting) return;
    reminders?.refreshBadge();
    // Reattach read-only watches after sleep. Never resend chat/tool input or
    // restart a live PTY as a side effect of a power event.
    mainWindow?.webContents.send(eventChannel, { type: "host:resume" });
  });
  powerMonitor.on("shutdown", () => {
    shuttingDown = true;
    app.quit();
  });
  openWindow();
  if (process.platform === "darwin" && app.isPackaged) {
    try {
      macUpdater = loadMacUpdater(process.resourcesPath);
      macUpdater.start(nativeUpdateEvent);
    } catch (error) { macUpdater = undefined; updaterStartupError = error; }
    refreshUpdateMenu();
  }
  void drainFolders();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.once("ready", (_event, launchInfo) => { notificationLaunch = activityNotificationLaunchId(launchInfo); });
  app.on("open-file", (event, path) => { event.preventDefault(); queueFolders([path]); });
  app.on("second-instance", (_event, argv, cwd) => {
    revealWindow();
    queueFolders(projectArguments(argv.slice(app.isPackaged ? 1 : 2), cwd));
  });
  app.on("activate", revealWindow);
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", event => {
    if (shutdownComplete || !host) return;
    event.preventDefault();
    if (exiting) return;
    if (preparingUpdate && !shuttingDown) return;
    // System shutdown bypasses an outstanding confirmation, but repeated Cmd+Q
    // cannot bypass either the confirmation or asynchronous host cleanup.
    if (shuttingDown || !quitGuard) { shutdownHost(); return; }
    if (quitPending) return;
    quitPending = true;
    void quitGuard.request().then(allowed => {
      if (exiting) return;
      if (allowed) shutdownHost();
      else revealWindow();
    }, shutdownHost).finally(() => { quitPending = false; });
  });
  if (app.isPackaged) queueFolders(projectArguments(process.argv.slice(1), process.cwd()));
  void app.whenReady().then(initialize).catch(error => {
    dialog.showErrorBox("Pideck could not start", error instanceof Error ? error.message : "Startup failed.");
    app.quit();
  });
}
