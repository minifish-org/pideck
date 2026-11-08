import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { ArrowLeft, RotateCw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Project } from "../shared/api";
import { useAppearance } from "./appearance";
import { connectTerminal, type TerminalStatus } from "./terminal-connection";
import "@xterm/xterm/css/xterm.css";
import "./workspace.css";

type TerminalProps = {
  project: Project;
  visible: boolean;
  overlay: boolean;
  focusOnShow: boolean;
  panelControls?: ReactNode;
  onClose: () => void;
  onExit(projectId: string): void;
};
const opening: TerminalStatus = { type: "opening", message: "Starting shell…" };

function terminalPalette(container: HTMLElement) {
  const tokens = getComputedStyle(container);
  const token = (name: string) => tokens.getPropertyValue(name).trim();
  const accent = token("--fgColor-accent");
  const background = token("--bgColor-inset");
  return {
    fontFamily: token("--mono"),
    theme: {
      background, foreground: token("--fgColor-default"), cursor: accent, cursorAccent: background,
      scrollbarSliderBackground: token("--borderColor-default"),
      scrollbarSliderHoverBackground: token("--borderColor-emphasis"),
      scrollbarSliderActiveBackground: token("--fgColor-muted"),
      selectionBackground: token("--selection-bgColor"),
      selectionInactiveBackground: token("--control-transparent-bgColor-selected"),
      black: token("--ansi-black"), red: token("--ansi-red"), green: token("--ansi-green"),
      yellow: token("--ansi-yellow"), blue: token("--ansi-blue"), magenta: token("--ansi-magenta"),
      cyan: token("--ansi-cyan"), white: token("--ansi-white"),
      brightBlack: token("--ansi-blackBright"), brightRed: token("--ansi-redBright"), brightGreen: token("--ansi-greenBright"),
      brightYellow: token("--ansi-yellowBright"), brightBlue: token("--ansi-blueBright"), brightMagenta: token("--ansi-magentaBright"),
      brightCyan: token("--ansi-cyanBright"), brightWhite: token("--ansi-whiteBright"),
    },
  };
}

function announceNewShell(terminal: Terminal, notice: string) {
  const normal = terminal.buffer.normal;
  let row = terminal.rows - 1;
  while (row > normal.cursorY && !normal.getLine(normal.baseY + row)?.translateToString(true)) row--;
  // 1047 returns from the alternate screen without restoring a stale saved cursor.
  // Reset modes and append below visible content to preserve the previous shell's output.
  terminal.write(`\x18\x1b[?1047;1000;1006;2026l\x1b[!p\x1b[${row + 1};1H\r\n[${notice}]\r\n`);
}

export function TerminalPanel(props: TerminalProps) {
  return <ProjectTerminal key={props.project.id} {...props} />;
}

function ProjectTerminal(props: TerminalProps) {
  const { visible } = props;
  const [activated, setActivated] = useState(false);
  useEffect(() => { if (visible) setActivated(true); }, [visible]);

  return <section className="workspace-terminal" id={visible ? "workspace-terminal" : undefined}
    aria-label="Project terminal" hidden={!visible}>
    {(visible || activated) && <TerminalInstance {...props} />}
  </section>;
}

function TerminalInstance({ project, visible, overlay, focusOnShow, onClose, onExit, panelControls }: TerminalProps) {
  const appearance = useAppearance();
  const element = useRef<HTMLDivElement>(null);
  const screen = useRef<{ terminal: Terminal; fit: () => void } | null>(null);
  const stopConnection = useRef<(() => void) | undefined>(undefined);
  const previousHost = useRef(0);
  const [host, setHost] = useState<{ generation: number; disconnected?: string }>({ generation: 0 });
  const [attempt, setAttempt] = useState<number | null>(0);
  const [status, setStatus] = useState<TerminalStatus>(opening);
  const [issue, setIssue] = useState("");

  useEffect(() => {
    const container = element.current;
    if (!container) return;
    const palette = terminalPalette(container);
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: false,
      fontFamily: palette.fontFamily,
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: palette.theme,
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
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    const unsubscribe = window.pideck.onEvent(event => {
      if (event.type === "host:disconnected") setHost(current => ({ ...current, disconnected: event.message }));
      if (event.type === "host:restart") setHost(current => ({ generation: current.generation + 1 }));
    });
    return () => {
      screen.current = null;
      observer.disconnect();
      unsubscribe();
      terminal.dispose();
    };
  }, []);

  useLayoutEffect(() => {
    const active = screen.current;
    const container = element.current;
    if (!active || !container) return;
    const palette = terminalPalette(container);
    active.terminal.options.theme = palette.theme;
  }, [appearance]);

  useEffect(() => {
    const terminal = screen.current?.terminal;
    if (!terminal || host.disconnected || attempt === null) return;
    if (host.generation !== previousHost.current) {
      previousHost.current = host.generation;
      announceNewShell(terminal, "Workspace reconnected. Starting a new shell.");
    } else if (attempt > 0) announceNewShell(terminal, "Starting a new shell.");
    setIssue("");
    setStatus(opening);
    const connection = connectTerminal({
      bridge: window.pideck,
      projectId: project.id,
      initialSize: { cols: terminal.cols, rows: terminal.rows },
      write: (data, callback) => terminal.write(data, callback),
      status: next => {
        setStatus(next);
        if (next.type === "exited" || next.type === "failed") setAttempt(null);
        if (next.type === "exited" && next.exitCode === 0) {
          onExit(project.id);
        }
      },
      issue: setIssue,
    });
    stopConnection.current = connection.stop;
    const write = terminal.onData(connection.input);
    const resize = terminal.onResize(connection.resize);
    return () => {
      stopConnection.current = undefined;
      resize.dispose();
      write.dispose();
      // Unmounting a view is not a request to stop its project shell.
      connection.stop(false);
    };
  }, [project.id, host, attempt, onExit]);

  useEffect(() => {
    if (!visible) return;
    screen.current?.fit();
    if (focusOnShow) {
      setAttempt(current => current ?? 1);
      screen.current?.terminal.focus();
    }
  }, [visible, focusOnShow]);

  const failed = status.type === "failed" || (status.type === "exited" && status.exitCode !== 0);
  const statusMessage = host.disconnected ?? (failed ? `${status.message} · Restart the shell to try again.` : status.message);
  function restartShell() {
    // Unsubscribe before the old shell can report an exit and close the panel.
    stopConnection.current?.();
    setStatus(opening);
    setAttempt(current => (current ?? 0) + 1);
    screen.current?.terminal.focus();
  }

  return <div className="workspace-terminal-content">
    <header className="workspace-panel-header">
      {visible && overlay && <button type="button" className="workspace-icon-button workspace-back" onClick={onClose}
        aria-label="Back to chat" title="Back to chat"><ArrowLeft size={17} aria-hidden="true" /></button>}
      <h2>Terminal</h2>
      <span className="workspace-terminal-status" data-state={host.disconnected || failed ? "failed" : status.type} role="status" title={statusMessage}>
        {statusMessage}
      </span>
      <div className="workspace-panel-actions">
        <button type="button" className="workspace-icon-button" aria-label="Restart shell"
          title="Restart shell (stops the current shell and its foreground command)"
          disabled={Boolean(host.disconnected) || status.type === "opening"} onClick={restartShell}>
          <RotateCw size={16} aria-hidden="true" />
        </button>
      </div>
      {panelControls}
    </header>
    {issue && <p className="workspace-terminal-issue" role="alert">{issue}</p>}
    <div className="workspace-terminal-body" ref={element} />
  </div>;
}
