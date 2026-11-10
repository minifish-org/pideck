import { Component, type ReactNode } from 'react';
import { flushDraftImages } from './preferences';

export function RecoveryScreen() {
  return <div className="app"><main className="recovery-screen" role="alert">
    <h1>The interface stopped unexpectedly.</h1>
    <p>Your workspace is still running. Recover the interface without resending messages or terminal input.</p>
    <button type="button" className="button button--primary" autoFocus onClick={() => {
      void flushDraftImages().catch(() => {}).then(() => window.location.reload());
    }}>Recover workspace</button>
  </main></div>;
}

export class RecoveryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <RecoveryScreen /> : this.props.children; }
}
