import { screen } from "electron";
import type { BrowserWindow, Rectangle } from "electron";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const minimumWindow = { width: 760, height: 560 };
const defaultWindow = { width: 1420, height: 930 };
type Snapshot = { bounds: Rectangle; maximized: boolean };

async function readSnapshot(file: string): Promise<Snapshot | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<Snapshot> | null;
    const bounds = value?.bounds;
    if (bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(value => Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000)
      && bounds.width > 0 && bounds.height > 0 && typeof value.maximized === "boolean") {
      return { bounds, maximized: value.maximized };
    }
  } catch {
    // A missing or damaged preferences file starts with a default window.
  }
}

function overlaps(left: Rectangle, right: Rectangle) {
  return left.x < right.x + right.width && right.x < left.x + left.width
    && left.y < right.y + right.height && right.y < left.y + left.height;
}

export async function openWindowState(directory: string) {
  const file = join(directory, "window-state.json");
  const temporary = file + ".tmp";
  let snapshot = await readSnapshot(file);
  let pending: Snapshot | undefined;
  let timer: NodeJS.Timeout | undefined;
  let writing: Promise<void> = Promise.resolve();

  function options() {
    const saved = snapshot?.bounds;
    const matching = saved && screen.getDisplayMatching(saved);
    const onDisplay = saved && matching && overlaps(saved, matching.workArea);
    const area = (onDisplay ? matching : screen.getPrimaryDisplay()).workArea;
    const width = Math.max(minimumWindow.width, Math.min(saved?.width ?? defaultWindow.width, area.width));
    const height = Math.max(minimumWindow.height, Math.min(saved?.height ?? defaultWindow.height, area.height));
    const x = onDisplay ? Math.max(area.x, Math.min(saved.x, area.x + area.width - width))
      : area.x + Math.max(0, Math.round((area.width - width) / 2));
    const y = onDisplay ? Math.max(area.y, Math.min(saved.y, area.y + area.height - height))
      : area.y + Math.max(0, Math.round((area.height - height) / 2));
    return { bounds: { x, y, width, height }, maximized: snapshot?.maximized ?? false };
  }

  function flush() {
    clearTimeout(timer);
    const next = pending;
    pending = undefined;
    if (!next) return writing;
    writing = writing.then(async () => {
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, file);
      } catch {
        await rm(temporary, { force: true }).catch(() => {});
      }
    });
    return writing;
  }

  function capture(window: BrowserWindow) {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const next = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = pending = next;
    clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, 200);
    timer.unref();
  }

  return { options, capture, flush };
}
