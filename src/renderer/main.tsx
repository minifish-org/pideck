import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import '@primer/primitives/dist/css/functional/themes/light.css';
import { App } from './App';
import { initializeAppearance } from './appearance';
import './app.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing renderer root');
await initializeAppearance();
createRoot(root).render(<StrictMode><App /></StrictMode>);
