import './index.css';

import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { App } from './app';

const container = document.getElementById('app');
const root = createRoot(container!);
root.render(createElement(App));
