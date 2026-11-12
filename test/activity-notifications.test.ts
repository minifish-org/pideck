import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  ActivityNotifications, activityNotificationId, activityNotificationLaunchId, parseActivityNotificationId,
  type ActivityDestination, type ActivityNotification,
} from "../src/main/activity-notifications.js";
import type { SessionActivity } from "../src/shared/api.js";

const first = { projectId: "project", sessionId: "first" };
const second = { projectId: "project", sessionId: "second" };
const running = (taskId = 1): SessionActivity => ({ ...first, taskId, state: "running", settled: false });
const finished = (taskId = 1): SessionActivity => ({ ...first, taskId, state: "finished", settled: true, resultEntryId: 12 });

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const badges: number[] = [];
  const shown: { notice: ActivityNotification; click: () => void; closed: number }[] = [];
  const opened: ActivityDestination[] = [];
  let viewing: string | undefined;
  const controller = new ActivityNotifications({
    setBadge: count => { badges.push(count); },
    show: (notice, click) => {
      const notification = { notice, click, closed: 0 };
      shown.push(notification);
      return { close() { notification.closed++; } };
    },
    isViewing: item => item.sessionId === viewing,
    open: item => { opened.push(item); },
    delayMs: 600,
  });
  t.after(() => controller.dispose());
  return { controller, badges, shown, opened, view: (sessionId?: string) => { viewing = sessionId; } };
}

test("background completion notifies once, counts unread sessions and clears only the read result", t => {
  const { controller, badges, shown, opened } = fixture(t);
  controller.update([]);
  controller.update([running()]);
  controller.update([finished()]);
  controller.update([finished()]);
  t.mock.timers.tick(600);
  assert.equal(shown.length, 1);
  assert.equal(badges.at(-1), 1);
  assert.equal(shown[0]!.notice.body, "Work finished. Open to view the result.");
  shown[0]!.click();
  assert.deepEqual(opened, [{ ...first, taskId: 1, resultEntryId: 12 }]);
  assert.equal(badges.at(-1), 1, "notification click is not a read receipt");
  controller.update([finished(), { ...finished(2), ...second }]);
  t.mock.timers.tick(600);
  assert.equal(badges.at(-1), 2);
  controller.update([{ ...finished(2), ...second }]);
  assert.equal(badges.at(-1), 1);
  assert.equal(shown[0]!.closed, 1);
  shown[0]!.click();
  assert.equal(opened.length, 1, "stale clicks cannot reopen a read or removed session");
  controller.update([]);
  assert.equal(shown[1]!.closed, 1);
  assert.equal(badges.at(-1), 0);
});

test("notification labels are one line and use the latest explicit session title", t => {
  const { controller, shown } = fixture(t);
  const notice = { ...finished(), notificationLabels: { projectName: "Workspace\n\u202E工具", sessionTitle: "Old title" } };
  controller.update([]);
  controller.update([notice]);
  controller.update([{ ...notice, notificationLabels: { ...notice.notificationLabels, sessionTitle: "Review\t界面" } }]);
  t.mock.timers.tick(600);
  assert.equal(shown[0]!.notice.title, "Workspace 工具 · Review 界面");
  assert.equal(shown[0]!.notice.body, "Work finished. Open to view the result.");

  controller.update([{ ...finished(2), ...second, notificationLabels: { projectName: "🚀".repeat(15) } }]);
  t.mock.timers.tick(600);
  assert.equal(shown[1]!.notice.title, `${"🚀".repeat(13)}… · Session`);
});

test("foreground result and quick read never generate notifications, while another session does", t => {
  const { controller, shown, view } = fixture(t);
  controller.update([]);
  view(first.sessionId);
  controller.update([finished()]);
  t.mock.timers.tick(600);
  assert.equal(shown.length, 0);
  view();
  controller.update([finished()]);
  t.mock.timers.tick(600);
  assert.equal(shown.length, 0, "viewed foreground work is not delayed until app backgrounding");
  controller.update([finished(2)]);
  controller.update([]);
  t.mock.timers.tick(600);
  assert.equal(shown.length, 0, "read during delivery grace period cancels notification");
  view(first.sessionId);
  controller.update([{ ...finished(3), ...second }]);
  t.mock.timers.tick(600);
  assert.equal(shown.length, 1);
});

test("new queued work cancels a premature finished alert and notifies only after the final completion", t => {
  const { controller, shown } = fixture(t);
  controller.update([running()]);
  controller.update([finished()]);
  t.mock.timers.tick(300);
  controller.update([running(2)]);
  t.mock.timers.tick(600);
  assert.equal(shown.length, 0);
  controller.update([finished(2)]);
  t.mock.timers.tick(600);
  assert.equal(shown.length, 1);
  assert.equal(shown[0]!.notice.id, activityNotificationId(finished(2)));
});

test("host restart restores badges and delivered notification navigation without reposting old results", t => {
  const { controller, shown, badges, opened } = fixture(t);
  const id = activityNotificationId(finished());
  let closed = 0;
  controller.restore(id, { close() { closed++; } });
  controller.update([finished()]);
  t.mock.timers.tick(600);
  assert.equal(shown.length, 0);
  assert.equal(badges.at(-1), 1);
  assert.equal(controller.activate(id), true);
  assert.equal(opened.length, 1);
  controller.update([finished()], { baseline: true });
  t.mock.timers.tick(600);
  assert.equal(shown.length, 0);
  controller.update([running(2)], { baseline: true });
  assert.equal(closed, 1);
  assert.equal(controller.activate(id), false);
  controller.update([finished(2)]);
  t.mock.timers.tick(600);
  assert.equal(shown.length, 1);
  assert.equal(controller.restore(id, { close() { closed++; } }), false);
  assert.equal(closed, 2);
});

test("attention is reported once for a task and failures are private", t => {
  const { controller, shown, badges } = fixture(t);
  controller.update([running()]);
  controller.update([{ ...running(), state: "attention" }]);
  t.mock.timers.tick(600);
  assert.equal(shown.length, 1);
  assert.equal(badges.at(-1), 0);
  assert.match(shown[0]!.notice.body, /needs attention/);
  controller.update([{ ...running(), state: "attention", settled: true }]);
  t.mock.timers.tick(600);
  assert.equal(shown.length, 1);
  assert.equal(badges.at(-1), 1);
  controller.update([running(2)]);
  controller.update([{ ...running(2), state: "attention", settled: true }]);
  t.mock.timers.tick(600);
  assert.equal(shown.length, 2);
  assert.equal(shown[1]!.notice.body, "Work could not finish. Open to review.");
});

test("restored stale or malformed notification IDs are removed and cannot select arbitrary sessions", t => {
  const { controller, opened } = fixture(t);
  controller.update([finished()]);
  let closed = 0;
  assert.equal(controller.restore("pideck-activity:bad", { close() { closed++; } }), false);
  assert.equal(controller.restore(activityNotificationId({ ...finished(), sessionId: "deleted" }), { close() { closed++; } }), false);
  assert.equal(closed, 2);
  assert.equal(controller.activate("pideck-activity:bad"), false);
  assert.equal(controller.activate(activityNotificationId(finished(99))), false);
  assert.deepEqual(opened, []);
  assert.equal(controller.restore("some-other-notice", { close() { closed++; } }), false);
  assert.equal(closed, 2, "do not interfere with unrelated native notifications");
  const destination = { projectId: "项目: a", sessionId: "会话/%", taskId: 50 };
  assert.deepEqual(parseActivityNotificationId(activityNotificationId(destination)), destination);
  for (const id of ["pideck-activity:a:b:0", "pideck-activity:a:b:1.5", "pideck-activity:%:b:1", "pideck-activity:a:b:9007199254740993"]) {
    assert.equal(parseActivityNotificationId(id), undefined);
  }
});

test("early native activation waits for the host snapshot and validates the persisted unread result", t => {
  const { controller, opened } = fixture(t);
  const id = activityNotificationId(finished());
  assert.equal(controller.activate(id), true);
  assert.deepEqual(opened, []);
  controller.update([finished()]);
  assert.deepEqual(opened, [{ ...first, taskId: 1, resultEntryId: 12 }]);
});

test("macOS cold-start launch information accepts only this app's notification default action", () => {
  const identifier = activityNotificationId(finished());
  assert.equal(activityNotificationLaunchId({ identifier, actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier" }), identifier);
  for (const launchInfo of [null, undefined, identifier, {}, { identifier },
    { identifier, actionIdentifier: "com.apple.UNNotificationDismissActionIdentifier" },
    { identifier: "foreign", actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier" }]) {
    assert.equal(activityNotificationLaunchId(launchInfo), undefined);
  }
});

test("early activation cannot resurrect a removed session on cold startup", t => {
  const { controller, opened } = fixture(t);
  controller.activate(activityNotificationId(finished()));
  controller.update([]);
  assert.deepEqual(opened, []);
});

test("unsupported notifications and badge permission failures never interrupt the host", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new ActivityNotifications({
    setBadge() { throw new Error("Permission denied"); },
    show() { throw new Error("Not supported"); },
    isViewing: () => false,
    open() { throw new Error("Window closed"); },
  });
  controller.update([]);
  controller.update([finished()]);
  assert.doesNotThrow(() => t.mock.timers.tick(600));
  assert.equal(controller.activate(activityNotificationId(finished())), false);
  controller.dispose();
  controller.update([finished(2)]);
  assert.doesNotThrow(() => t.mock.timers.tick(600));
});
