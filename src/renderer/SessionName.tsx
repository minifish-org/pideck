import { useLayoutEffect, useRef, useState } from 'react';
import { normalizeSessionTitle, sessionTitleLimit } from '../shared/session-title';
import './session-name.css';

export function SessionName({ title, onFinish }: {
  title: string;
  onFinish: (name: string | undefined, restoreFocus: boolean) => void;
}) {
  const [name, setName] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  function finish(save: boolean, restoreFocus: boolean) {
    if (finished.current) return;
    finished.current = true;
    const clean = save ? normalizeSessionTitle(name) : '';
    onFinish(clean && clean !== title ? clean : undefined, restoreFocus);
  }

  return <form className="session-name" onSubmit={(event) => {
    event.preventDefault();
    finish(true, true);
  }}>
    <input ref={input} type="text" aria-label="Session name" autoComplete="off" spellCheck={false}
      maxLength={sessionTitleLimit} value={name} onChange={event => setName(event.currentTarget.value)}
      onBlur={() => finish(true, false)} onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          finish(false, true);
        }
      }} />
  </form>;
}
