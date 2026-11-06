import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, safeStorage, session, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eventChannel, invokeChannel, menuStateChannel, type RemovalTarget } from "../shared/transport";
import { safeAuthUrl } from "../host/auth-flows";
import { CredentialVault } from "./credentials";
import { HostClient } from "./host-client";
import { installDesktopMenu, isMenuState } from "./menu";
import { isCommand, validPayload } from "./validation";
import { minimumWindow, openWindowState } from "./window-state";

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
let owner = 0;
let host: HostClient | undefined;
let exiting = false;

function ownsFrame(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, window: BrowserWindow): boolean {
  return event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame?.url === appUrl;
}

function openWindow() {
  const initial = windowState.options();
  const window = new BrowserWindow({
    ...initial.bounds,
    minWidth: minimumWindow.width,
    minHeight: minimumWindow.height,
    backgroundColor: "#0d1117",
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
  desktopMenu?.attach(window);
  let windowOwner = ++owner;

  const retire = () => { void host?.request(windowOwner, "owner:close", undefined).catch(() => {}); };
  window.webContents.on("did-navigate", () => {
    retire();
    windowOwner = ++owner;
  });
  window.webContents.on("render-process-gone", () => retire());
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
    if (mainWindow === window) mainWindow = undefined;
  });
  window.once("ready-to-show", () => {
    window.show();
    if (initial.maximized) window.maximize();
  });
  void window.loadURL(appUrl).catch(() => {
    if (!window.isDestroyed()) {
      dialog.showErrorBox("Pideck", "The desktop interface could not be loaded.");
      window.destroy();
    }
  });
}

async function initialize() {
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
      return new Response(file.body, { status: file.status, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  session.defaultSession.on("will-download", event => event.preventDefault());

  const dataDir = app.getPath("userData");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  windowState = await openWindowState(dataDir);
  const vault = new CredentialVault(dataDir, safeStorage);
  const client = new HostClient(dataDir, vault, (target, event) => {
    if (target === owner && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(eventChannel, event);
  }, () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(eventChannel, { type: "host:restart" });
  }, message => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(eventChannel, { type: "host:disconnected", message });
  });
  host = client;
  client.start();
  const menu = installDesktopMenu(openWindow);
  desktopMenu = menu;
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
    return client.request(requestOwner, "removal:execute", { ...target, scope: plan.scope });
  }

  ipcMain.handle(invokeChannel, async (event, command: unknown, payload: unknown) => {
    const window = mainWindow;
    const requestOwner = owner;
    if (!window || window.isDestroyed() || !ownsFrame(event, window)) throw new Error("Unauthorized window.");
    if (!isCommand(command) || !validPayload(command, payload)) throw new Error("Invalid workspace request.");

    if (command === "project:open") {
      const result = await dialog.showOpenDialog(window, { title: "Open a project", properties: ["openDirectory"] });
      if (result.canceled || !result.filePaths[0] || window.isDestroyed() || requestOwner !== owner) return null;
      return client.request(requestOwner, "project:add", { directory: result.filePaths[0] });
    }
    if (command === "project:remove") {
      if (!validPayload(command, payload)) throw new Error("Invalid workspace request.");
      return confirmRemoval(window, requestOwner, { projectId: payload.projectId });
    }
    if (command === "session:remove") {
      if (!validPayload(command, payload)) throw new Error("Invalid workspace request.");
      return confirmRemoval(window, requestOwner, { projectId: payload.projectId, sessionId: payload.sessionId });
    }
    if (command === "project:trust" && validPayload(command, payload)) {
      const projects = await client.request(requestOwner, "project:list", undefined);
      const project = projects.find(item => item.id === payload.projectId);
      if (!project) throw new Error("Project not found.");
      if (project.trusted) return project;
      if (window.isDestroyed() || requestOwner !== owner) return null;
      const result = await dialog.showMessageBox(window, {
        type: "warning",
        buttons: ["Cancel", "Trust Project"],
        defaultId: 0,
        cancelId: 0,
        message: `Trust “${project.name}”?`,
        detail: `${project.directory}\n\nPideck can run commands and modify files as your user. Open projects only when you trust their contents. Commands can access files outside this folder.`,
      });
      if (result.response !== 1 || window.isDestroyed() || requestOwner !== owner) return null;
      return client.request(requestOwner, command, payload);
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
    return client.request(requestOwner, command, payload);
  });

  openWindow();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => mainWindow?.focus());
  app.on("activate", () => { if (host && !mainWindow) openWindow(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", event => {
    if (exiting || !host) return;
    exiting = true;
    event.preventDefault();
    if (mainWindow) windowState.capture(mainWindow);
    void Promise.allSettled([host.close(), windowState.flush()]).finally(() => app.quit());
  });
  void app.whenReady().then(initialize).catch(error => {
    dialog.showErrorBox("Pideck could not start", error instanceof Error ? error.message : "Startup failed.");
    app.quit();
  });
}
