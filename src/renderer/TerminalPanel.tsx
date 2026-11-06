import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Project } from "../shared/api";
import { Icon } from "./Icons";
import { connectTerminal, type TerminalStatus } from "./terminal-connection";
import "@xterm/xterm/css/xterm.css";
import "./workspace.css";

type TerminalProps = { project: Project; visible: boolean; focusOnShow: boolean; onExit(projectId: string): void };
const opening: TerminalStatus = { type: "opening", message: "Starting shell…" };
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

function ProjectTerminal({ project, visible, focusOnShow, onExit }: TerminalProps) {
  const [activated, setActivated] = useState(false);
  useEffect(() => { if (visible) setActivated(true); }, [visible]);

  return <section className="workspace-terminal" id={visible ? "workspace-terminal" : undefined}
    aria-label="Project terminal" hidden={!visible}>
    {project.trusted && (visible || activated)
      ? <TerminalInstance project={project} visible={visible} focusOnShow={focusOnShow} onExit={onExit} />
      : <>
        <header className="workspace-panel-header"><h2>Terminal</h2></header>
        <p className="workspace-empty">Trust this project to open a terminal.</p>
      </>}
  </section>;
}

function TerminalInstance({ project, visible, focusOnShow, onExit }: TerminalProps) {
  const element = useRef<HTMLDivElement>(null);
  const screen = useRef<{ terminal: Terminal; fit: () => void; search: SearchAddon; searchOptions: ISearchOptions } | null>(null);
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

  useEffect(() => {
    const container = element.current;
    if (!container) return;
    const tokens = getComputedStyle(container);
    const token = (name: string, fallback: string) => tokens.getPropertyValue(name).trim() || fallback;
    const accent = token("--accent", "#58a6ff");
    const background = token("--terminal-bg", token("--bg", "#0d1117"));
    const border = token("--border", "#30363d");
    const selection = token("--accent-border", "#1f6feb");
    const terminal = new Terminal({
      // SearchAddon's match decorations use xterm's registerDecoration API.
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: token("--mono", '"SF Mono", Consolas, "Liberation Mono", monospace'),
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      overviewRuler: { width: 8 },
      theme: {
        background, foreground: token("--text", "#f0f6fc"), cursor: accent, cursorAccent: background,
        overviewRulerBorder: border, scrollbarSliderBackground: border,
        scrollbarSliderHoverBackground: token("--dim", "#8b949e"),
        scrollbarSliderActiveBackground: token("--muted", "#9198a1"),
        selectionBackground: selection, selectionInactiveBackground: token("--surface-hover", "#21262d"),
        // Primer Dark Default ANSI colors.
        black: "#2f3742", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
        blue: "#58a6ff", magenta: "#be8fff", cyan: "#39c5cf", white: "#f0f6fc",
        brightBlack: "#656c76", brightRed: "#ffa198", brightGreen: "#56d364", brightYellow: "#e3b341",
        brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#56d4dd", brightWhite: "#ffffff",
      },
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
    screen.current = { terminal, fit, search, searchOptions: { decorations: {
      matchBackground: token("--accent-soft", "#1f6feb26"), matchOverviewRuler: selection,
      activeMatchBorder: accent, activeMatchColorOverviewRuler: accent,
    } } };
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
    const write = terminal.onData(connection.input);
    const resize = terminal.onResize(connection.resize);
    return () => {
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
    if (finding && query) active?.search.findNext(query, { ...active.searchOptions, incremental: true });
    else {
      active?.search.clearDecorations();
      setMatches(undefined);
    }
  }, [finding, query]);

  const failed = status.type === "failed" || (status.type === "exited" && status.exitCode !== 0);
  const statusMessage = host.disconnected ?? (failed ? `${status.message} · Reopen Terminal to try again.` : status.message);
  const matchLabel = query
    ? !matches?.resultCount ? "No results"
      : matches.resultIndex < 0 ? `${matches.resultCount} results` : `${matches.resultIndex + 1} of ${matches.resultCount}`
    : "";
  const isMac = window.pideck.platform === "darwin";
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
      </div>
    </header>
    {issue && <p className="workspace-terminal-issue" role="alert">{issue}</p>}
    <div className="workspace-terminal-body" ref={element} />
  </div>;
}
