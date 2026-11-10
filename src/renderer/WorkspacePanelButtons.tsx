import { Icon } from './Icons';

export function WorkspacePanelButtons({ reviewOpen, terminalVisible, disabled, reviewTitle, terminalTitle,
  onReview, onTerminal }: {
  reviewOpen: boolean;
  terminalVisible: boolean;
  disabled: boolean;
  reviewTitle: string;
  terminalTitle: string;
  onReview: () => void;
  onTerminal: () => void;
}) {
  return <div className="title-panels" role="group" aria-label="Workspace panels">
    <button className="icon-button panel-toggle" id="toggle-review" type="button" aria-label="Changes"
      title={reviewTitle} aria-pressed={reviewOpen} aria-controls={reviewOpen ? 'review-panel' : undefined}
      disabled={disabled} onClick={onReview}><Icon name="diff" /></button>
    <button className="icon-button panel-toggle" id="toggle-terminal" type="button" aria-label="Terminal"
      title={terminalTitle} aria-pressed={terminalVisible} aria-controls={terminalVisible ? 'workspace-terminal' : undefined}
      disabled={disabled} onClick={onTerminal}><Icon name="terminal" /></button>
  </div>;
}
