import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eventChannel, invokeChannel } from "../shared/transport";
import { loadKeys, storeKeys } from "./credentials";
import { HostClient } from "./host-client";
import { isCommand, validPayload } from "./validation";

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
  { scheme: "pideck", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.enableSandbox();

let mainWindow: BrowserWindow | undefined;
let owner = 0;
let host: HostClient | undefined;
let exiting = false;

function ownsFrame(event: IpcMainInvokeEvent, window: BrowserWindow): boolean {
  return event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame?.url === appUrl;
}

function openWindow() {
  const window = new BrowserWindow({
    width: 1420,
    height: 930,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#141615",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
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
  window.once("closed", () => {
    retire();
    if (mainWindow === window) mainWindow = undefined;
  });
  window.once("ready-to-show", () => window.show());
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
  let keys = await loadKeys(dataDir);
  let keySaves: Promise<void> = Promise.resolve();
  const client = new HostClient(dataDir, keys, (target, event) => {
    if (target === owner && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(eventChannel, event);
  }, () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(eventChannel, { type: "host:restart" });
  });
  host = client;
  client.start();

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
    if (command === "model:save-key" && validPayload(command, payload)) {
      const { provider, key } = payload;
      const save = keySaves.then(async () => {
        const models = await client.request(requestOwner, "model:list", undefined);
        if (!models.some(model => model.provider === provider)) throw new Error("Provider not supported.");
        if (window.isDestroyed() || requestOwner !== owner) throw new Error("This window has closed.");
        const next = { ...keys, [provider]: key.trim() };
        await storeKeys(dataDir, next);
        keys = next;
        client.setKeys(keys);
        await client.request(requestOwner, command, { provider, key: key.trim() });
      });
      keySaves = save.catch(() => {});
      return save;
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
    void host.close().finally(() => app.quit());
  });
  void app.whenReady().then(initialize).catch(error => {
    dialog.showErrorBox("Pideck could not start", error instanceof Error ? error.message : "Startup failed.");
    app.quit();
  });
}
