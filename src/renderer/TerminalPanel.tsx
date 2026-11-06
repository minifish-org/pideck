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

type TerminalProps = { project: Project; visible: boolean; focusOnShow?: boolean };
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

function focusTerminalInput(search: HTMLInputElement | null, terminal?: Terminal) {
  if (!search) return terminal?.focus();
  search.focus();
  search.select();
}

export function TerminalPanel(props: TerminalProps) {
  return <ProjectTerminal key={props.project.id} {...props} />;
}

function ProjectTerminal({ project, visible, focusOnShow }: TerminalProps) {
  const [activated, setActivated] = useState(false);
  useEffect(() => { if (visible) setActivated(true); }, [visible]);

  return <section className="workspace-terminal" aria-label="Project terminal" hidden={!visible}>
    {project.trusted && (visible || activated)
      ? <TerminalInstance project={project} visible={visible} focusOnShow={focusOnShow} />
      : <>
        <header className="workspace-panel-header"><h2>Terminal</h2></header>
        <p className="workspace-empty">Trust this project to open a terminal.</p>
      </>}
  </section>;
}

function TerminalInstance({ project, visible, focusOnShow = true }: TerminalProps) {
  const element = useRef<HTMLDivElement>(null);
  const screen = useRef<{ terminal: Terminal; fit: () => void; search: SearchAddon } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const endShell = useRef<HTMLButtonElement>(null);
  const cancelEnd = useRef<HTMLButtonElement>(null);
  const restartShell = useRef<HTMLButtonElement>(null);
  const previousHost = useRef(0);
  const [host, setHost] = useState<{ generation: number; disconnected?: string }>({ generation: 0 });
  const [attempt, setAttempt] = useState<number | null>(0);
  const [status, setStatus] = useState<TerminalStatus>(opening);
  const [issue, setIssue] = useState("");
  const [finding, setFinding] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const searchWasOpen = useRef(finding);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ISearchResultChangeEvent>();

  useEffect(() => {
    const container = element.current;
    if (!container) return;
    const tokens = getComputedStyle(container);
    const token = (name: string, fallback: string) => tokens.getPropertyValue(name).trim() || fallback;
    const accent = token("--accent", "#c9ee95");
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
        background: token("--bg", "#191b1b"), foreground: token("--text", "#ebede8"), cursor: accent,
        overviewRulerBorder: token("--border", "#303439"),
        selectionBackground: "#485441", red: token("--danger", "#ff9b96"), green: accent,
        yellow: "#e8cc8e", blue: "#9fb9f5", magenta: "#c7a6e5", cyan: "#8dc9c8",
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
    if (!visible) return;
    screen.current?.fit();
    if (focusOnShow) focusTerminalInput(searchInput.current, screen.current?.terminal);
  }, [visible, focusOnShow]);

  useEffect(() => {
    const changed = searchWasOpen.current !== finding;
    searchWasOpen.current = finding;
    if (visible && changed) focusTerminalInput(searchInput.current, screen.current?.terminal);
  }, [visible, finding]);

  useEffect(() => {
    const search = screen.current?.search;
    if (finding && query) search?.findNext(query, { ...searchOptions, incremental: true });
    else {
      search?.clearDecorations();
      setMatches(undefined);
    }
  }, [finding, query]);

  const restartable = status.type === "exited" || status.type === "failed" || status.type === "stopped";
  const canEnd = !host.disconnected && !restartable;
  useEffect(() => {
    if (confirmEnd && (!visible || !canEnd)) setConfirmEnd(false);
    else if (confirmEnd) cancelEnd.current?.focus();
  }, [canEnd, confirmEnd, visible]);

  function cancelEnding() {
    setConfirmEnd(false);
    requestAnimationFrame(() => endShell.current?.focus());
  }

  function stopShell() {
    setAttempt(null);
    setIssue("");
    setStatus({ type: "stopped", message: "Shell ended" });
    setConfirmEnd(false);
    requestAnimationFrame(() => restartShell.current?.focus());
  }

  const matchLabel = query
    ? !matches?.resultCount ? "No results"
      : matches.resultIndex < 0 ? `${matches.resultCount} results` : `${matches.resultIndex + 1} of ${matches.resultCount}`
    : "";
  const isMac = window.pideck.platform === "darwin";
  const searchId = `terminal-find-${project.id}`;
  return <div className="workspace-terminal-content" onKeyDownCapture={event => {
    const findKey = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey;
    if (event.key === "Escape" && confirmEnd) {
      event.preventDefault();
      event.stopPropagation();
      cancelEnding();
    } else if (!confirmEnd && findKey && !event.altKey && event.key.toLowerCase() === "f") {
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
      <span className="workspace-terminal-status" data-state={host.disconnected ? "failed" : status.type} role="status">
        {host.disconnected ?? status.message}
      </span>
      {confirmEnd && canEnd ? <div className="workspace-panel-actions workspace-end-shell" role="group" aria-label="Confirm end shell">
        <span>End shell and interrupt commands?</span>
        <button className="workspace-action" type="button" ref={cancelEnd} onClick={cancelEnding}>Cancel</button>
        <button className="workspace-action workspace-action--danger" type="button" onClick={stopShell}>End shell</button>
      </div> : <div className="workspace-panel-actions">
        {restartable && !host.disconnected && <button className="workspace-action workspace-action--restart" type="button" ref={restartShell}
          onClick={() => {
            setAttempt(value => (value ?? 0) + 1);
            screen.current?.terminal.focus();
          }}>Restart shell</button>}
        {finding ? <div className="workspace-terminal-search" id={searchId} role="search" aria-label="Find in terminal scrollback">
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
          <button type="button" className="workspace-icon-button" aria-label="Close terminal search" title="Close search (Esc)"
            onClick={() => setFinding(false)}><Icon name="close" /></button>
        </div> : <button type="button" className="workspace-icon-button" onClick={() => setFinding(true)}
          aria-label="Find in terminal" title={`Find in terminal (${isMac ? "⌘F" : "Ctrl+Shift+F"})`}><Search size={16} aria-hidden="true" /></button>}
        {canEnd && !finding && <button className="workspace-icon-button workspace-end-button" type="button" ref={endShell}
          aria-label="End shell" title="End shell" onClick={() => setConfirmEnd(true)}><Icon name="stop" /></button>}
      </div>}
    </header>
    {issue && <p className="workspace-terminal-issue" role="alert">{issue}</p>}
    <div className="workspace-terminal-body" ref={element} />
  </div>;
}
