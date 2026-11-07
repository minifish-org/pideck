import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { ArrowLeft, RotateCw, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Project } from "../shared/api";
import { Icon } from "./Icons";
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
      overviewRulerBorder: "#0000", scrollbarSliderBackground: token("--borderColor-default"),
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
    searchOptions: { decorations: {
      matchBackground: token("--control-bgColor-active"), matchOverviewRuler: token("--fgColor-muted"),
      activeMatchBorder: accent, activeMatchColorOverviewRuler: accent,
    } } satisfies ISearchOptions,
  };
}

function announceNewShell(terminal: Terminal, notice: string) {
  const normal = terminal.buffer.normal;
  let row = terminal.rows - 1;
  while (row > normal.cursorY && !normal.getLine(normal.baseY + row)?.translateToString(true)) row--;
  // 1047 returns from the alternate screen without restoring a stale saved cursor.
  // Reset modes and append below visible content so the previous shell stays searchable.
  terminal.write(`\x18\x1b[?1047;1000;1006;2026l\x1b[!p\x1b[${row + 1};1H\r\n[${notice}]\r\n`);
}

function focusTerminalInput(search: HTMLInputElement | null, terminal?: Terminal) {
  if (!search) return terminal?.focus();
  search.focus();
  search.select();
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
  const screen = useRef<{ terminal: Terminal; fit: () => void; search: SearchAddon; searchOptions: ISearchOptions } | null>(null);
  const stopConnection = useRef<(() => void) | undefined>(undefined);
  const searchInput = useRef<HTMLInputElement>(null);
  const previousHost = useRef(0);
  const [host, setHost] = useState<{ generation: number; disconnected?: string }>({ generation: 0 });
  const [attempt, setAttempt] = useState<number | null>(0);
  const [status, setStatus] = useState<TerminalStatus>(opening);
  const [issue, setIssue] = useState("");
  const [finding, setFinding] = useState(false);
  const searchWasOpen = useRef(finding);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ISearchResultChangeEvent>();
  const appearanceViewport = useRef<{ top: number; following: boolean } | undefined>(undefined);

  useEffect(() => {
    const container = element.current;
    if (!container) return;
    const palette = terminalPalette(container);
    const terminal = new Terminal({
      // SearchAddon's match decorations use xterm's registerDecoration API.
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: false,
      fontFamily: palette.fontFamily,
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      overviewRuler: { width: 8 },
      theme: palette.theme,
    });
    const addon = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(addon);
    terminal.loadAddon(search);
    terminal.open(container);
    const fit = () => {
      if (!container.clientWidth || !container.clientHeight) return;
      const size = addon.proposeDimensions();
      if (!size) return;
      if (size.cols > 500 || size.rows > 300) terminal.resize(Math.min(size.cols, 500), Math.min(size.rows, 300));
      else addon.fit();
    };
    screen.current = { terminal, fit, search, searchOptions: palette.searchOptions };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    const results = search.onDidChangeResults(setMatches);
    const unsubscribe = window.pideck.onEvent(event => {
      if (event.type === "host:disconnected") setHost(current => ({ ...current, disconnected: event.message }));
      if (event.type === "host:restart") setHost(current => ({ generation: current.generation + 1 }));
    });
    return () => {
      screen.current = null;
      observer.disconnect();
      results.dispose();
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
    active.searchOptions = palette.searchOptions;
    const buffer = active.terminal.buffer.active;
    appearanceViewport.current = { top: buffer.viewportY, following: buffer.viewportY === buffer.baseY };
    active.search.clearDecorations();
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
          setFinding(false);
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
      connection.stop();
    };
  }, [project.id, host, attempt, onExit]);

  useEffect(() => {
    if (!visible) return;
    screen.current?.fit();
    if (focusOnShow) {
      setAttempt(current => current ?? 1);
      focusTerminalInput(searchInput.current, screen.current?.terminal);
    }
  }, [visible, focusOnShow]);

  useEffect(() => {
    const changed = searchWasOpen.current !== finding;
    searchWasOpen.current = finding;
    if (visible && changed) focusTerminalInput(searchInput.current, screen.current?.terminal);
  }, [visible, finding]);

  useEffect(() => {
    const active = screen.current;
    const viewport = appearanceViewport.current;
    appearanceViewport.current = undefined;
    if (finding && query) active?.search.findNext(query, { ...active.searchOptions, incremental: true });
    else {
      active?.search.clearDecorations();
      setMatches(undefined);
    }
    if (viewport?.following) active?.terminal.scrollToBottom();
    else if (viewport) active?.terminal.scrollToLine(viewport.top);
  }, [finding, query, appearance]);

  const failed = status.type === "failed" || (status.type === "exited" && status.exitCode !== 0);
  const statusMessage = host.disconnected ?? (failed ? `${status.message} · Restart the shell to try again.` : status.message);
  const matchLabel = query
    ? !matches?.resultCount ? "No results"
      : matches.resultIndex < 0 ? `${matches.resultCount} results` : `${matches.resultIndex + 1} of ${matches.resultCount}`
    : "";
  const isMac = window.pideck.platform === "darwin";
  function restartShell() {
    // Unsubscribe before the old shell can report an exit and close the panel.
    stopConnection.current?.();
    setStatus(opening);
    setAttempt(current => (current ?? 0) + 1);
    setFinding(false);
    screen.current?.terminal.focus();
  }
  function findMatch(previous: boolean) {
    const active = screen.current;
    if (!active || !query) return;
    if (previous) active.search.findPrevious(query, active.searchOptions);
    else active.search.findNext(query, active.searchOptions);
  }

  return <div className="workspace-terminal-content" data-toolbar={finding ? "find" : undefined} onKeyDownCapture={event => {
    const findKey = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey;
    if (findKey && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      setFinding(true);
      focusTerminalInput(searchInput.current);
    } else if (finding && event.key === "Escape" && event.target instanceof Element
      && event.target.closest(".workspace-terminal-search")) {
      event.preventDefault();
      event.stopPropagation();
      setFinding(false);
    }
  }}>
    <header className="workspace-panel-header">
      {visible && overlay && <button type="button" className="workspace-icon-button workspace-back" onClick={onClose}
        aria-label="Back to chat" title="Back to chat"><ArrowLeft size={17} aria-hidden="true" /></button>}
      <h2>Terminal</h2>
      <span className="workspace-terminal-status" data-state={host.disconnected || failed ? "failed" : status.type} role="status" title={statusMessage}>
        {statusMessage}
      </span>
      <div className="workspace-panel-actions">
        {finding ? <div className="workspace-terminal-search" role="search" aria-label="Find in terminal scrollback">
          <input type="search" ref={searchInput} aria-label="Find in terminal output" value={query}
            placeholder="Find in terminal…" onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key !== "Enter" || !query) return;
              event.preventDefault();
              findMatch(event.shiftKey);
            }} />
          <span className="workspace-search-results" role="status">{matchLabel}</span>
          <button type="button" className="workspace-icon-button" disabled={!query}
            aria-label="Previous terminal match" title="Previous match (Shift+Enter)"
            onClick={() => findMatch(true)}><Icon name="arrowUp" /></button>
          <button type="button" className="workspace-icon-button" disabled={!query}
            aria-label="Next terminal match" title="Next match (Enter)"
            onClick={() => findMatch(false)}><Icon name="arrowDown" /></button>
          <button type="button" className="workspace-icon-button" aria-label="Close terminal search" title="Close search (Esc)"
            onClick={() => setFinding(false)}><Icon name="close" /></button>
        </div> : <button type="button" className="workspace-icon-button" onClick={() => setFinding(true)}
          aria-label="Find in terminal" title={`Find in terminal (${isMac ? "⌘F" : "Ctrl+Shift+F"})`}><Search size={16} aria-hidden="true" /></button>}
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
