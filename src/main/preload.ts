import { contextBridge, ipcRenderer } from "electron";
import type { Pideck } from "../shared/api";
import { eventChannel, invokeChannel } from "../shared/transport";

const pideck: Pideck = {
  platform: process.platform,
  invoke: (command, ...args) => ipcRenderer.invoke(invokeChannel, command, args[0]),
  onEvent(listener) {
    if (typeof listener !== "function") throw new TypeError("An event listener is required.");
    const handler: Parameters<typeof ipcRenderer.on>[1] = (_event, data) => listener(data);
    ipcRenderer.on(eventChannel, handler);
    return () => { ipcRenderer.removeListener(eventChannel, handler); };
  },
};

contextBridge.exposeInMainWorld("pideck", pideck);
