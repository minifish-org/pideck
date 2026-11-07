import { useLayoutEffect, useRef, type RefObject } from 'react';
import { Icon } from './Icons';

export function WorkspacePanelButtons({ reviewOpen, terminalVisible, disabled, reviewTitle, terminalTitle,
  onReview, onTerminal, focusMemory }: {
  reviewOpen: boolean;
  terminalVisible: boolean;
  disabled: boolean;
  reviewTitle: string;
  terminalTitle: string;
  onReview: () => void;
  onTerminal: () => void;
  focusMemory: RefObject<string | undefined>;
}) {
  const group = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const id = focusMemory.current;
    focusMemory.current = undefined;
    if (id && document.activeElement === document.body) {
      group.current?.querySelector<HTMLButtonElement>(`#${id}`)?.focus({ preventScroll: true });
    }
    return () => {
      const active = document.activeElement;
      if (active instanceof HTMLButtonElement && group.current?.contains(active)) focusMemory.current = active.id;
    };
  }, [focusMemory]);

  return <div className="title-panels" role="group" aria-label="Workspace panels" ref={group}>
    <button className="icon-button panel-toggle" id="toggle-review" type="button" aria-label="Changes"
      title={reviewTitle} aria-pressed={reviewOpen} aria-controls={reviewOpen ? 'review-panel' : undefined}
      disabled={disabled} onClick={onReview}><Icon name="diff" /></button>
    <button className="icon-button panel-toggle" id="toggle-terminal" type="button" aria-label="Terminal"
      title={terminalTitle} aria-pressed={terminalVisible} aria-controls={terminalVisible ? 'workspace-terminal' : undefined}
      disabled={disabled} onClick={onTerminal}><Icon name="terminal" /></button>
  </div>;
}
