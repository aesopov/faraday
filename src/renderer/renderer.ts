import './index.css';

import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { App } from './app';

// In browser mode (no Electron preload), set up the WebSocket bridge
if (!window.electron) {
  const { createWsBridge } = await import('./wsBridge');
  const wsUrl = `ws://${location.host}/ws`;
  window.electron = await createWsBridge(wsUrl);
}

const container = document.getElementById('app');
const root = createRoot(container!);
root.render(createElement(App));
