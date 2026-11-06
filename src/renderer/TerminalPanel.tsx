import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { HostEvent, Project } from "../shared/api";
import "@xterm/xterm/css/xterm.css";
import "./workspace.css";

type TerminalProps = { project: Project; visible: boolean; onClose: () => void };
type TerminalEvent = Extract<HostEvent, { type: "terminal:data" | "terminal:exit" }>;
type Status = { type: "opening" | "running" | "exited" | "failed"; message: string };

export function TerminalPanel(props: TerminalProps) {
  return <ProjectTerminal key={props.project.id} {...props} />;
}

function ProjectTerminal({ project, visible, onClose }: TerminalProps) {
  const [activated, setActivated] = useState(false);

  useEffect(() => {
    if (visible) setActivated(true);
  }, [visible]);

  return <section className="workspace-terminal" aria-label="Project terminal" hidden={!visible}>
    {project.trusted && (visible || activated)
      ? <TerminalInstance projectId={project.id} visible={visible} onClose={onClose} />
      : <>
        <header className="workspace-panel-header">
          <h2>Terminal</h2>
          <button type="button" className="workspace-icon-button workspace-refresh" onClick={onClose}
            aria-label="Hide terminal" title="Hide terminal">×</button>
        </header>
        <p className="workspace-empty">Trust this project to open a terminal.</p>
      </>}
  </section>;
}

function TerminalInstance({ projectId, visible, onClose }: {
  projectId: string; visible: boolean; onClose: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const screen = useRef<{ terminal: Terminal; fit: () => void } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>({ type: "opening", message: "Starting shell…" });
  const [issue, setIssue] = useState("");

  useEffect(() => {
    const container = element.current;
    if (!container) return;
    setIssue("");
    setStatus({ type: "opening", message: "Starting shell…" });

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"SF Mono", Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: {
        background: "#16181b", foreground: "#ebede8", cursor: "#c9ee95", selectionBackground: "#485441",
        red: "#ff9b96", green: "#c9ee95", yellow: "#e8cc8e", blue: "#9fb9f5", magenta: "#c7a6e5", cyan: "#8dc9c8",
      },
    });
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    terminal.open(container);
    const fit = () => {
      if (!container.clientWidth || !container.clientHeight) return;
      const size = addon.proposeDimensions();
      if (!size) return;
      if (size.cols > 500 || size.rows > 300) terminal.resize(Math.min(size.cols, 500), Math.min(size.rows, 300));
      else addon.fit();
    };
    screen.current = { terminal, fit };
    fit();

    let disposed = false;
    let terminalId: string | undefined;
    let sequence = -1;
    let exited = false;
    const pending: TerminalEvent[] = [];

    const reportIssue = (cause: unknown) => {
      if (!disposed && !exited) setIssue(errorMessage(cause));
    };
    const apply = (event: TerminalEvent) => {
      if (event.terminalId !== terminalId || event.sequence <= sequence) return;
      sequence = event.sequence;
      if (event.type === "terminal:data") terminal.write(event.data);
      else {
        exited = true;
        setStatus({ type: "exited", message: `Shell exited (${event.exitCode})` });
      }
    };

    const unsubscribe = window.pideck.onEvent(event => {
      if (event.type === "host:restart") {
        setAttempt(value => value + 1);
        return;
      }
      if ((event.type !== "terminal:data" && event.type !== "terminal:exit") || event.projectId !== projectId) return;
      if (terminalId) apply(event);
      else pending.push(event);
    });
    const write = terminal.onData(data => {
      if (!terminalId || exited) return;
      for (const part of data.match(/[\s\S]{1,8192}/gu) ?? []) {
        void window.pideck.invoke("terminal:input", { projectId, terminalId, data: part }).catch(reportIssue);
      }
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      if (terminalId && !exited) {
        void window.pideck.invoke("terminal:resize", { projectId, terminalId, cols, rows }).catch(reportIssue);
      }
    });
    const observer = new ResizeObserver(fit);
    observer.observe(container);

    const cols = terminal.cols;
    const rows = terminal.rows;
    void window.pideck.invoke("terminal:open", { projectId, cols, rows }).then(open => {
      if (disposed) {
        closeTerminal(projectId, open.terminalId);
        return;
      }
      terminalId = open.terminalId;
      sequence = open.sequence;
      exited = open.exited;
      terminal.write(open.data);
      setStatus(exited ? { type: "exited", message: "Shell exited" } : { type: "running", message: "Shell running" });
      for (const event of pending) apply(event);
      pending.length = 0;
      if (!exited && (cols !== terminal.cols || rows !== terminal.rows)) {
        void window.pideck.invoke("terminal:resize", { projectId, terminalId, cols: terminal.cols, rows: terminal.rows }).catch(reportIssue);
      }
    }, cause => {
      if (!disposed) setStatus({ type: "failed", message: errorMessage(cause) });
    });

    return () => {
      disposed = true;
      screen.current = null;
      observer.disconnect();
      unsubscribe();
      resize.dispose();
      write.dispose();
      terminal.dispose();
      if (terminalId) closeTerminal(projectId, terminalId);
    };
  }, [projectId, attempt]);

  useEffect(() => {
    if (!visible) return;
    screen.current?.fit();
    screen.current?.terminal.focus();
  }, [visible, attempt]);

  const restartable = status.type === "exited" || status.type === "failed";
  return <>
    <header className="workspace-panel-header">
      <h2>Terminal</h2>
      <span className="workspace-terminal-status" data-state={status.type} role="status">{status.message}</span>
      {restartable && <button className="workspace-action workspace-refresh" type="button"
        onClick={() => setAttempt(value => value + 1)}>Restart shell</button>}
      <button className={`workspace-icon-button${restartable ? "" : " workspace-refresh"}`} type="button" onClick={onClose}
        aria-label="Hide terminal" title="Hide terminal">×</button>
    </header>
    {issue && <p className="workspace-terminal-issue" role="alert">{issue}</p>}
    <div className="workspace-terminal-body" ref={element} />
  </>;
}

function closeTerminal(projectId: string, terminalId: string) {
  void window.pideck.invoke("terminal:close", { projectId, terminalId }).catch(() => {});
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "The terminal is unavailable.";
}
