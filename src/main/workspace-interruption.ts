import type { MessageBoxOptions } from "electron";
import type { HostResult } from "../shared/transport";

export type InterruptionAction = "quit" | "update";
type WorkspaceWork = Pick<HostResult["host:status"], "active" | "terminalBusy">;

// Quit and update use the same conservative decision: only a checked, idle
// workspace may close silently. An unavailable host also requires consent.
export function workspaceInterruptionPrompt(action: InterruptionAction, work?: WorkspaceWork): MessageBoxOptions | undefined {
  if (work && !work.active && work.terminalBusy === false) return undefined;
  const updating = action === "update";
  const verb = updating ? "Restart" : "Quit";
  const terminalMayBeBusy = work?.terminalBusy !== false;
  return {
    type: "warning",
    message: !work ? `${verb} while workspace status is unavailable?`
      : work.active ? `${verb} while AI work is running?` : `${verb} while a terminal may be busy?`,
    detail: [
      !work ? "Pideck could not check running AI work or terminals. They may be interrupted."
        : work.active && "Running AI work will be interrupted.",
      work && terminalMayBeBusy && `Open terminals may have running commands or unfinished input. ${updating ? "Restarting" : "Quitting"} closes them.`,
      "Your conversations, queued edits and drafts stay saved.",
    ].filter(Boolean).join(" "),
    buttons: ["Keep Working", updating ? "Restart and Update" : "Quit"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

// Coalesce repeated Cmd+Q through both the status read and the native sheet.
export class QuitGuard {
  private pending?: Promise<boolean>;
  constructor(private readonly confirm: () => Promise<boolean>) {}

  request() {
    if (this.pending) return this.pending;
    const pending = Promise.resolve().then(() => this.confirm())
      .finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    return pending;
  }
}
