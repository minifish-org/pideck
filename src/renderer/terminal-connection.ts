import type { Pideck, TerminalEvent } from "../shared/api";

type Size = { cols: number; rows: number };
export type TerminalStatus = { type: "opening" | "running" | "exited" | "stopped" | "failed"; message: string };

const inputLimit = 256 * 1024;

export function connectTerminal(options: {
  bridge: Pideck;
  projectId: string;
  initialSize: Size;
  write(data: string, callback: () => void): void;
  status(status: TerminalStatus): void;
  issue(message: string): void;
}) {
  const { bridge, projectId, initialSize, write, status, issue } = options;
  let active = true;
  let terminalId: string | undefined;
  let exited = false;
  let received = 0;
  let parsed = 0;
  let acknowledged = 0;
  let openingOutput = false;
  let synchronizing = false;
  let dispatching = false;
  let size = initialSize;
  let lastSize = initialSize;
  let inputLength = 0;
  const inputQueue: string[] = [];
  const outOfOrder = new Map<number, TerminalEvent>();

  function close(id: string) {
    void bridge.invoke("terminal:close", { projectId, terminalId: id }).catch(() => {});
  }

  function stop(release = true) {
    if (!active) return;
    active = false;
    unsubscribe();
    inputQueue.length = 0;
    outOfOrder.clear();
    if (release && terminalId) close(terminalId);
  }

  function fail(cause: unknown) {
    if (!active) return;
    status({ type: "failed", message: cause instanceof Error ? cause.message : "The terminal is unavailable." });
    stop();
  }

  function accept(event: TerminalEvent) {
    if (!active || event.terminalId !== terminalId || event.sequence <= received) return;
    outOfOrder.set(event.sequence, event);
    let next = outOfOrder.get(received + 1);
    while (next) {
      const { sequence } = next;
      outOfOrder.delete(sequence);
      received = sequence;
      if (next.type === "terminal:data") {
        write(next.data, () => {
          if (!active) return;
          parsed = sequence;
          synchronize();
        });
      } else {
        exited = true;
        status({ type: "exited", message: `Shell exited (${next.exitCode})` });
        // The screen retains already queued writes even after the shell is released.
        stop();
        return;
      }
      next = outOfOrder.get(received + 1);
    }
    synchronize();
  }

  function synchronize() {
    if (!active || !terminalId || synchronizing) return;
    const replay = openingOutput || outOfOrder.size > 0;
    if (!replay && parsed === acknowledged) return;
    const through = parsed;
    const start = received;
    openingOutput = false;
    synchronizing = true;
    void bridge.invoke("terminal:sync", { projectId, terminalId, through, ...(replay ? { replay: true as const } : {}) })
      .then(events => {
        if (!active) return;
        acknowledged = through;
        for (const event of events) accept(event);
        if (replay && received === start && outOfOrder.size > 0) {
          fail(new Error("Terminal output was interrupted. Restart the shell to reconnect."));
        }
      }, fail).finally(() => {
        synchronizing = false;
        synchronize();
      });
  }

  async function dispatch() {
    if (!terminalId || !active || dispatching || exited) return;
    dispatching = true;
    const target = { projectId, terminalId };
    try {
      while (active && !exited) {
        if (size.cols !== lastSize.cols || size.rows !== lastSize.rows) {
          lastSize = size;
          await bridge.invoke("terminal:resize", { ...target, ...lastSize });
          continue;
        }
        const data = inputQueue.shift();
        if (!data) break;
        await bridge.invoke("terminal:input", { ...target, data });
        inputLength -= data.length;
      }
    } catch (cause) {
      fail(cause);
    } finally {
      dispatching = false;
    }
  }

  const unsubscribe = bridge.onEvent(event => {
    if (event.type === "host:disconnected") {
      stop(false);
      return;
    }
    if ((event.type !== "terminal:data" && event.type !== "terminal:exit") || event.projectId !== projectId) return;
    if (terminalId) accept(event);
    else openingOutput = true;
  });

  void bridge.invoke("terminal:open", { projectId, ...initialSize }).then(open => {
    if (!active) {
      close(open.terminalId);
      return;
    }
    terminalId = open.terminalId;
    received = open.sequence;
    if (open.data) {
      write(open.data, () => {
        if (!active) return;
        parsed = open.sequence;
        synchronize();
      });
    } else parsed = received;
    if (open.exited) {
      status({ type: "exited", message: "Shell exited" });
      stop();
      return;
    }
    status({ type: "running", message: "Shell running" });
    synchronize();
    void dispatch();
  }, fail);

  return {
    stop,
    input(data: string) {
      if (!active || !data) return;
      if (data.length + inputLength > inputLimit) {
        issue("The terminal input queue is full. Send smaller chunks of text.");
        return;
      }
      inputLength += data.length;
      // Preserve Unicode code points while splitting large pastes for IPC.
      inputQueue.push(...(data.match(/[\s\S]{1,8192}/gu) ?? []));
      issue("");
      void dispatch();
    },
    resize(next: Size) {
      size = next;
      void dispatch();
    },
  };
}
