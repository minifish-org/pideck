import { app, Menu } from "electron";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
import type { AppearancePreference, AppearanceState, MenuAction, MenuState } from "../shared/api";
import { menuActionChannel } from "../shared/transport";

const idle: MenuState = {
  canOpenProject: true,
  canSearchSessions: false,
  canOpenSettings: true,
  canCreateSession: false,
  canFocusComposer: false,
  canToggleNavigation: false,
  canUseWorkspace: false,
  navigationVisible: false,
  reviewVisible: false,
  terminalVisible: false,
};

export function isMenuState(value: unknown): value is MenuState {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(idle).every(key => typeof (value as Record<string, unknown>)[key] === "boolean");
}

export function installDesktopMenu(reopen: () => void, checkForUpdates: (window?: BrowserWindow) => Promise<void>, appearance: {
  get: () => AppearanceState;
  set: (preference: AppearancePreference) => Promise<void>;
}) {
  const mac = process.platform === "darwin";
  let window: BrowserWindow | undefined;
  let state: MenuState | undefined;
  let pending: MenuAction | undefined;
  let checkingUpdates = false;

  function dispatch(action: MenuAction) {
    if (!menu.getMenuItemById(action)?.enabled) return;
    if (window && !window.isDestroyed() && state) {
      window.webContents.send(menuActionChannel, action);
      return;
    }
    pending = action;
    if (!window || window.isDestroyed()) reopen();
  }

  function command(id: MenuAction, label: string, accelerator: string, type: "normal" | "checkbox" = "normal"): MenuItemConstructorOptions {
    return {
      id, label, type, accelerator,
      // On Windows/Linux the renderer can let the focused shell consume its Ctrl bindings.
      registerAccelerator: mac,
      click(item) {
        if (item.type === "checkbox") refresh();
        dispatch(id);
      },
    };
  }

  const separator = { type: "separator" } as const;
  const settings = command("settings", "Model Providers…", "CommandOrControl+,");
  const updates: MenuItemConstructorOptions = {
    id: "check-for-updates", label: "Check for Updates…",
    click(item) {
      if (!item.enabled || checkingUpdates) return;
      checkingUpdates = true;
      const nativeUpdater = mac && app.isPackaged;
      if (!nativeUpdater) item.enabled = false;
      void checkForUpdates(window).catch(() => {}).finally(() => {
        checkingUpdates = false;
        if (!nativeUpdater) item.enabled = true;
      });
    },
  };
  const template: MenuItemConstructorOptions[] = [];
  if (mac) {
    app.setAboutPanelOptions({ applicationName: "Pideck", applicationVersion: app.getVersion(),
      copyright: "Licensed under AGPL-3.0-only",
      credits: "Source and license notices: https://github.com/minifish-org/pideck\nThird-party license texts are included in the application package." });
    template.push({ label: "Pideck", submenu: [
      { role: "about", label: "About Pideck" }, updates, separator, settings, separator,
      { role: "hide", label: "Hide Pideck" }, { role: "quit", label: "Quit Pideck" },
    ] });
  }
  template.push(
    { label: mac ? "File" : "&File", submenu: [
      command("open-project", "Open Folder…", "CommandOrControl+O"),
      command("new-session", "New Session", "CommandOrControl+N"),
      separator,
      ...(mac ? [{ role: "close" as const }] : [settings, updates, separator, { role: "quit" as const }]),
    ] },
    { label: mac ? "Edit" : "&Edit", submenu: [
      { role: "undo" }, { role: "redo" }, separator,
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ] },
    { label: mac ? "View" : "&View", submenu: [
      command("search-sessions", "Search Sessions…", "CommandOrControl+K"),
      separator,
      command("toggle-navigation", "Sidebar", "CommandOrControl+Shift+B", "checkbox"),
      command("toggle-review", "Changes", "CommandOrControl+Shift+D", "checkbox"),
      command("toggle-terminal", "Terminal", "CommandOrControl+`", "checkbox"),
      command("focus-composer", "Focus Message", "CommandOrControl+L"),
      separator,
      { id: "appearance", label: "Appearance", submenu: ([
        ["system", "Follow System"], ["light", "Light"], ["dark", "Dark"],
      ] as const).map(([preference, label]) => ({
        id: `appearance-${preference}`, label, type: "radio", checked: appearance.get().preference === preference,
        click() { void appearance.set(preference).catch(() => {}); },
      })) },
      separator,
      { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom", label: "Actual Size" },
      separator,
      { role: "togglefullscreen" },
    ] },
  );
  if (mac) template.push({ role: "window", submenu: [{ role: "minimize" }] });
  const menu = Menu.buildFromTemplate(template);

  function refresh() {
    // Electron's radio setter selects the item even when assigned false.
    // Selecting the current preference lets the native group clear the rest.
    const selectedAppearance = menu.getMenuItemById(`appearance-${appearance.get().preference}`);
    if (selectedAppearance) selectedAppearance.checked = true;
    const current = state ?? idle;
    const commands = {
      "open-project": { enabled: current.canOpenProject },
      "search-sessions": { enabled: current.canSearchSessions },
      "new-session": { enabled: current.canCreateSession },
      settings: { enabled: current.canOpenSettings },
      "toggle-navigation": { enabled: current.canToggleNavigation, checked: current.navigationVisible },
      "toggle-review": { enabled: current.canUseWorkspace, checked: current.reviewVisible },
      "toggle-terminal": { enabled: current.canUseWorkspace, checked: current.terminalVisible },
      "focus-composer": { enabled: current.canFocusComposer },
    } satisfies Record<MenuAction, { enabled: boolean; checked?: boolean }>;
    for (const [id, value] of Object.entries(commands)) {
      const item = menu.getMenuItemById(id);
      if (item) {
        item.enabled = value.enabled;
        if ("checked" in value) item.checked = value.checked;
      }
    }
  }

  function reset() {
    state = undefined;
    refresh();
  }

  refresh();
  Menu.setApplicationMenu(menu);

  return {
    openProject: () => { reopen(); dispatch("open-project"); },
    refreshAppearance: refresh,
    attach(target: BrowserWindow) {
      window = target;
      reset();
      target.webContents.on("did-navigate", () => { if (window === target) reset(); });
      target.webContents.on("render-process-gone", () => { if (window === target) reset(); });
      target.once("closed", () => {
        if (window !== target) return;
        window = undefined;
        pending = undefined;
        reset();
      });
    },
    update(target: BrowserWindow, next: MenuState) {
      if (window !== target) return;
      state = next;
      refresh();
      if (pending) {
        const action = pending;
        pending = undefined;
        dispatch(action);
      }
    },
  };
}
