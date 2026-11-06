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

type TerminalProps = { project: Project; visible: boolean; onClose: () => void };
const opening: TerminalStatus = { type: "opening", message: "Starting shell…" };
const searchOptions: ISearchOptions = {
  decorations: {
    matchBackground: "#34423A", matchOverviewRuler: "#839872",
    activeMatchBorder: "#C9EE95", activeMatchColorOverviewRuler: "#C9EE95",
  },
};

function announceNewShell(terminal: Terminal, notice: string) {
  const normal = terminal.buffer.normal;
  let row = terminal.rows - 1;
  while (row > normal.cursorY && !normal.getLine(normal.baseY + row)?.translateToString(true)) row--;
  // 1047 returns from the alternate screen without restoring a stale saved cursor.
  // Reset modes and append below visible content so the previous shell stays searchable.
  terminal.write(`\x18\x1b[?1047;1000;1006;2026l\x1b[!p\x1b[${row + 1};1H\r\n[${notice}]\r\n`);
}

export function TerminalPanel(props: TerminalProps) {
  return <ProjectTerminal key={props.project.id} {...props} />;
}

function ProjectTerminal({ project, visible, onClose }: TerminalProps) {
  const [activated, setActivated] = useState(false);
  useEffect(() => { if (visible) setActivated(true); }, [visible]);

  return <section className="workspace-terminal" aria-label="Project terminal" hidden={!visible}>
    {project.trusted && (visible || activated)
      ? <TerminalInstance project={project} visible={visible} onClose={onClose} />
      : <>
        <header className="workspace-panel-header">
          <h2>Terminal</h2>
          <button type="button" className="workspace-icon-button workspace-refresh" onClick={onClose}
            aria-label="Hide terminal" title="Hide terminal"><Icon name="close" /></button>
        </header>
        <p className="workspace-empty">Trust this project to open a terminal.</p>
      </>}
  </section>;
}

function TerminalInstance({ project, visible, onClose }: TerminalProps) {
  const element = useRef<HTMLDivElement>(null);
  const screen = useRef<{ terminal: Terminal; fit: () => void; search: SearchAddon } | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const previousHost = useRef(0);
  const [host, setHost] = useState<{ generation: number; disconnected?: string }>({ generation: 0 });
  const [attempt, setAttempt] = useState<number | null>(0);
  const [status, setStatus] = useState<TerminalStatus>(opening);
  const [issue, setIssue] = useState("");
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ISearchResultChangeEvent>();

  useEffect(() => {
    const container = element.current;
    if (!container) return;
    const terminal = new Terminal({
      // SearchAddon's match decorations use xterm's registerDecoration API.
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"SF Mono", Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      overviewRuler: { width: 8 },
      theme: {
        background: "#16181b", foreground: "#ebede8", cursor: "#c9ee95", selectionBackground: "#485441",
        red: "#ff9b96", green: "#c9ee95", yellow: "#e8cc8e", blue: "#9fb9f5", magenta: "#c7a6e5", cyan: "#8dc9c8",
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
    screen.current = { terminal, fit, search };
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
        if (next.type === "exited") setAttempt(null);
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
  }, [project.id, host, attempt]);

  useEffect(() => {
    if (visible) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      screen.current?.fit();
    } else if (document.activeElement === document.body) previousFocus.current?.focus();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    if (finding) {
      searchInput.current?.focus();
      searchInput.current?.select();
    } else screen.current?.terminal.focus();
  }, [visible, finding]);

  useEffect(() => {
    const search = screen.current?.search;
    if (finding && query) search?.findNext(query, { ...searchOptions, incremental: true });
    else {
      search?.clearDecorations();
      setMatches(undefined);
    }
  }, [finding, query]);

  function toggleSearch() {
    setFinding(current => !current);
  }

  const restartable = status.type === "exited" || status.type === "failed" || status.type === "stopped";
  const matchLabel = query
    ? !matches?.resultCount ? "No results"
      : matches.resultIndex < 0 ? `${matches.resultCount} results` : `${matches.resultIndex + 1} of ${matches.resultCount}`
    : "";
  return <div className="workspace-terminal-content" onKeyDownCapture={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      setFinding(true);
      searchInput.current?.select();
    } else if (finding && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setFinding(false);
    }
  }}>
    <header className="workspace-panel-header">
      <h2>Terminal</h2>
      <span className="workspace-terminal-status" data-state={host.disconnected ? "failed" : status.type} role="status"
        title={project.directory}>{host.disconnected ?? status.message}</span>
      <button type="button" className="workspace-icon-button workspace-refresh" onClick={toggleSearch}
        aria-label="Find in terminal" aria-pressed={finding} title="Find in terminal"><Search size={15} aria-hidden="true" /></button>
      {restartable
        ? <button className="workspace-action" type="button" disabled={Boolean(host.disconnected)}
          onClick={() => setAttempt(value => (value ?? 0) + 1)}>Restart shell</button>
        : <button className="workspace-icon-button" type="button" aria-label="Stop shell" title="Stop shell" onClick={() => {
          setAttempt(null);
          setIssue("");
          setStatus({ type: "stopped", message: "Shell stopped" });
        }}><Icon name="stop" /></button>}
      <button className="workspace-icon-button" type="button" onClick={onClose}
        aria-label="Hide terminal" title="Hide terminal"><Icon name="close" /></button>
    </header>
    {finding && <div className="workspace-terminal-search" role="search" aria-label="Find in terminal scrollback">
      <input type="search" ref={searchInput} aria-label="Find in terminal output" value={query}
        placeholder="Find in terminal…" onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key !== "Enter" || !query) return;
          event.preventDefault();
          if (event.shiftKey) screen.current?.search.findPrevious(query, searchOptions);
          else screen.current?.search.findNext(query, searchOptions);
        }} />
      <span className="workspace-search-results" role="status">{matchLabel}</span>
      <button type="button" className="workspace-icon-button" disabled={!query}
        aria-label="Previous terminal match" title="Previous match (Shift+Enter)"
        onClick={() => screen.current?.search.findPrevious(query, searchOptions)}><Icon name="arrowUp" /></button>
      <button type="button" className="workspace-icon-button" disabled={!query}
        aria-label="Next terminal match" title="Next match (Enter)"
        onClick={() => screen.current?.search.findNext(query, searchOptions)}><Icon name="arrowDown" /></button>
    </div>}
    {issue && <p className="workspace-terminal-issue" role="alert">{issue}</p>}
    <div className="workspace-terminal-body" ref={element} />
  </div>;
}
