import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import '@primer/primitives/dist/css/functional/themes/light.css';
import { App } from './App';
import { initializeAppearance } from './appearance';
import { RecoveryBoundary, RecoveryScreen } from './RecoveryBoundary';
import './app.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing renderer root');
const application = createRoot(root);
try {
  await initializeAppearance();
  application.render(<StrictMode><RecoveryBoundary><App /></RecoveryBoundary></StrictMode>);
} catch {
  application.render(<RecoveryScreen />);
}
