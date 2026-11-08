import { app, Notification } from "electron";
import { createHash } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ActivityNotifications, parseActivityNotificationId,
  type ActivityNotificationHandle, type ActivityNotificationPorts,
} from "./activity-notifications.js";

const xml = (value: string) => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
})[character]!);

export function createNativeNotifications(ports: Pick<ActivityNotificationPorts, "isViewing" | "open">) {
  const references = new Map<string, { notification?: Notification }>();
  // Even isSupported/getHistory creates Electron's macOS notification presenter,
  // which requests authorization. Do not touch it on a profile's first launch.
  const historyMarker = join(app.getPath("userData"), "notification-history");
  const markHistory = () => { void writeFile(historyMarker, "", { flag: "wx", mode: 0o600 }).catch(() => {}); };

  function retain(id: string, notification: Notification): ActivityNotificationHandle {
    const reference = { notification: notification as Notification | undefined };
    references.set(id, reference);
    if (process.platform !== "win32") notification.on("click", () => { controller.activate(id); });
    notification.on("show", () => controller.refreshBadge());
    notification.on("failed", () => {
      if (references.get(id) === reference) references.delete(id);
      reference.notification?.removeAllListeners();
      reference.notification = undefined;
    });
    return {
      close() {
        const native = reference.notification;
        reference.notification = undefined;
        if (references.get(id) === reference) references.delete(id);
        try { native?.removeAllListeners(); native?.close(); } finally {
          if (process.platform === "darwin") Notification.remove(id);
        }
      },
    };
  }

  const controller = new ActivityNotifications({
    ...ports,
    setBadge(count) {
      if (process.platform === "darwin") app.dock?.setBadge(count ? count > 99 ? "99+" : String(count) : "");
      else app.setBadgeCount(count);
    },
    show(notice) {
      if (!Notification.isSupported()) return;
      if (process.platform === "darwin") markHistory();
      const notification = new Notification({
        ...notice,
        silent: true,
        ...(process.platform === "win32" ? {
          // Windows tags are limited to 64 UTF-16 units. Its activation payload
          // carries the full opaque ID independently of the short native tag.
          id: createHash("sha256").update(notice.id).digest("hex"),
          toastXml: `<toast launch="${xml(notice.id)}"><visual><binding template="ToastGeneric"><text>${xml(notice.title)}</text><text>${xml(notice.body)}</text></binding></visual><audio silent="true"/></toast>`,
        } : {}),
      });
      const handle = retain(notice.id, notification);
      try { notification.show(); } catch (error) { handle.close(); throw error; }
      return handle;
    },
  });

  if (process.platform === "win32") {
    app.setAppUserModelId("works.pideck.desktop");
    Notification.handleActivation(details => {
      if (details.type === "click" && parseActivityNotificationId(details.arguments)) controller.activate(details.arguments);
    });
  }

  const ready = process.platform === "darwin" ? access(historyMarker).then(async () => {
    for (const notification of await Notification.getHistory()) {
      if (!notification.id.startsWith("pideck-activity:")) continue;
      const handle = retain(notification.id, notification);
      controller.restore(notification.id, handle);
    }
  }).catch(() => {}) : Promise.resolve();

  // Await ready before starting the host to reattach old cards before activity
  // reconciliation; no show() call is made for restored notifications.
  return Object.assign(controller, { ready });
}
