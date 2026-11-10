import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Project, Session } from '../shared/api';
import { Icon } from './Icons';
import { searchSessions } from './session-search';
import './navigation-overlays.css';

export function SessionSearch({ projects, sessions, errors, onSelect, onRetry, onClose }: {
  projects: Project[];
  sessions: Record<string, Session[]>;
  errors: Record<string, string>;
  onSelect: (session: Session) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string>();
  const results = useMemo(() => searchSessions(projects, sessions, query), [projects, sessions, query]);
  const activeIndex = Math.max(0, results.findIndex(result => result.session.id === activeId));
  const active = results[activeIndex];
  const failed = projects.filter(project => errors[project.id]);
  const loading = projects.some(project => !sessions[project.id] && !errors[project.id]);

  useLayoutEffect(() => {
    const panel = dialog.current!;
    const opener = document.activeElement;
    panel.showModal();
    input.current?.focus();
    return () => {
      panel.close();
      if (document.activeElement === document.body && opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active?.session.id]);

  function choose(session: Session) {
    dialog.current?.close();
    onSelect(session);
  }

  return <dialog className="session-search" ref={dialog} aria-label="Search sessions"
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom)) onClose();
    }}>
    <div className="session-search-heading">
      <Icon name="search" />
      <input ref={input} type="text" inputMode="search" role="combobox" aria-label="Search sessions" autoComplete="off" spellCheck={false}
        placeholder="Search session titles or projects…" maxLength={240} value={query}
        aria-expanded="true" aria-autocomplete="list" aria-controls="session-search-results"
        aria-activedescendant={active ? `session-search-${active.session.id}` : undefined}
        onChange={event => { setQuery(event.currentTarget.value); setActiveId(undefined); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) {
            event.preventDefault();
            const next = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
            setActiveId(results[next]!.session.id);
          } else if (event.key === 'Enter' && active) {
            event.preventDefault();
            choose(active.session);
          }
        }} />
      <button className="icon-button" type="button" aria-label="Close search" title="Close search (Esc)" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
    <ul className="session-search-results" id="session-search-results" role="listbox" aria-label="Sessions" ref={list}>
      {results.map(({ project, session }, index) => <li key={session.id} role="option" id={`session-search-${session.id}`}
        aria-selected={index === activeIndex} className="session-search-result"
        onPointerMove={() => setActiveId(session.id)} onMouseDown={event => event.preventDefault()} onClick={() => choose(session)}>
        <Icon name={session.parentSessionId ? 'fork' : 'chat'} />
        <div><span className="session-search-title">{session.title}</span><span className="session-search-project">{project.name}</span></div>
      </li>)}
    </ul>
    <div className="session-search-status" role="status">
      {loading ? 'Loading sessions…' : results.length ? `${results.length} session${results.length === 1 ? '' : 's'}`
        : query.trim() ? 'No sessions found.' : failed.length ? 'Sessions could not be loaded.' : 'No sessions yet.'}
    </div>
    {failed.map(project => <div className="session-search-error" role="alert" key={project.id}>
      Could not load {project.name}. <button className="inline-action" type="button" onClick={onRetry}>Retry</button>
    </div>)}
  </dialog>;
}
