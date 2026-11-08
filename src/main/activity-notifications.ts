import type { Selection, SessionActivity } from "../shared/api.js";

export type ActivityNotification = {
  id: string;
  groupId: string;
  title: string;
  body: string;
};
export type ActivityNotificationHandle = { close(): void };
export type ActivityDestination = Selection & { taskId: number; resultEntryId?: number };
export type ActivityNotificationPorts = {
  setBadge(count: number): void;
  show(notification: ActivityNotification, activate: () => void): ActivityNotificationHandle | undefined;
  isViewing(selection: Selection): boolean;
  open(destination: ActivityDestination): void | Promise<void>;
  delayMs?: number;
};

const prefix = "pideck-activity:";
const keyOf = (item: Selection) => JSON.stringify([item.projectId, item.sessionId]);
const deservesNotification = (item: SessionActivity) => item.settled || item.state === "attention";

export function activityNotificationId(item: ActivityDestination) {
  return `${prefix}${encodeURIComponent(item.projectId)}:${encodeURIComponent(item.sessionId)}:${item.taskId}`;
}

export function parseActivityNotificationId(id: string): ActivityDestination | undefined {
  if (!id.startsWith(prefix)) return;
  const parts = id.slice(prefix.length).split(":");
  if (parts.length !== 3 || !/^[1-9]\d*$/.test(parts[2]!)) return;
  const taskId = Number(parts[2]);
  if (!Number.isSafeInteger(taskId)) return;
  try {
    const projectId = decodeURIComponent(parts[0]!);
    const sessionId = decodeURIComponent(parts[1]!);
    if (!projectId || !sessionId) return;
    return { projectId, sessionId, taskId };
  } catch {
    return;
  }
}

export function activityNotificationLaunchId(launchInfo: unknown): string | undefined {
  if (!launchInfo || typeof launchInfo !== "object") return;
  if (!("actionIdentifier" in launchInfo) || launchInfo.actionIdentifier !== "com.apple.UNNotificationDefaultActionIdentifier") return;
  if (!("identifier" in launchInfo) || typeof launchInfo.identifier !== "string") return;
  return parseActivityNotificationId(launchInfo.identifier) ? launchInfo.identifier : undefined;
}

// Main-process projection of the host's activity state. It never decides that a
// result was read: only the focused renderer's visible-result acknowledgement does.
export class ActivityNotifications {
  private latest = new Map<string, SessionActivity>();
  private handled = new Map<string, number>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delivered = new Map<string, ActivityNotificationHandle>();
  private initialized = false;
  private disposed = false;
  private pendingActivation?: string;

  constructor(private readonly ports: ActivityNotificationPorts) {}

  update(items: readonly SessionActivity[], options: { baseline?: boolean } = {}) {
    if (this.disposed) return;
    const baseline = options.baseline || !this.initialized;
    this.initialized = true;
    this.latest = new Map(items.map(item => [keyOf(item), { ...item }]));
    for (const [key, timer] of this.pending) {
      const item = this.latest.get(key);
      if (!item || !deservesNotification(item) || this.handled.get(key) !== item.taskId || baseline) {
        clearTimeout(timer);
        this.pending.delete(key);
      }
    }
    for (const [id, handle] of this.delivered) {
      if (!this.current(id)) this.dismiss(id, handle);
    }
    for (const key of this.handled.keys()) {
      if (!this.latest.has(key)) this.handled.delete(key);
    }
    for (const [key, item] of this.latest) {
      if (!deservesNotification(item) || this.handled.get(key) === item.taskId) continue;
      this.handled.set(key, item.taskId);
      if (baseline) continue;
      const expectedId = activityNotificationId(item);
      const timer = setTimeout(() => {
        this.pending.delete(key);
        const current = this.current(expectedId);
        if (!current || this.disposed || this.ports.isViewing(current)) return;
        try {
          const handle = this.ports.show({
            id: expectedId,
            groupId: "pideck-activity",
            title: "Pideck",
            body: current.state === "finished" ? "Work finished. Open to view the result."
              : current.settled ? "Work could not finish. Open to review."
              : "Work needs attention. Open to continue.",
          }, () => { this.activate(expectedId); });
          if (handle) this.delivered.set(expectedId, handle);
        } catch {
          // Notification support or OS permission must never interrupt work.
        }
        this.refreshBadge();
      }, this.ports.delayMs ?? 600);
      timer.unref?.();
      this.pending.set(key, timer);
    }
    this.refreshBadge();
    if (this.pendingActivation) {
      const id = this.pendingActivation;
      this.pendingActivation = undefined;
      this.activate(id);
    }
  }

  // Reattach delivered OS notifications after restart without posting them again.
  // Bind the native object's click event to activate(id) before calling restore.
  restore(id: string, handle: ActivityNotificationHandle) {
    if (!id.startsWith(prefix)) return false;
    if (this.disposed || (this.initialized && !this.current(id))) {
      this.dismiss(id, handle);
      return false;
    }
    const previous = this.delivered.get(id);
    if (previous && previous !== handle) this.dismiss(id, previous);
    this.delivered.set(id, handle);
    return true;
  }

  activate(id: string) {
    // Native activation can arrive before the host has opened its store. Defer
    // navigation until that first authoritative snapshot can validate the ID.
    if (!this.disposed && !this.initialized && parseActivityNotificationId(id)) {
      this.pendingActivation = id;
      return true;
    }
    const item = this.current(id);
    if (this.disposed || !item) return false;
    try {
      void Promise.resolve(this.ports.open({
        projectId: item.projectId,
        sessionId: item.sessionId,
        taskId: item.taskId,
        ...(item.resultEntryId !== undefined ? { resultEntryId: item.resultEntryId } : {}),
      })).catch(() => {});
    } catch {
      return false;
    }
    return true;
  }

  refreshBadge() {
    if (this.disposed) return;
    try {
      this.ports.setBadge(Array.from(this.latest.values()).filter(item => item.settled).length);
    } catch {
      // A denied notification permission also disables macOS Dock badges.
    }
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.pendingActivation = undefined;
    // Leave delivered notifications in Notification Center across app exits.
    this.delivered.clear();
  }

  private current(id: string) {
    const destination = parseActivityNotificationId(id);
    if (!destination) return;
    const item = this.latest.get(keyOf(destination));
    return item?.taskId === destination.taskId && deservesNotification(item) ? item : undefined;
  }

  private dismiss(id: string, handle: ActivityNotificationHandle) {
    this.delivered.delete(id);
    try { handle.close(); } catch { /* The OS may already have dismissed it. */ }
  }
}
