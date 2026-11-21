import 'katex/dist/katex.min.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/thread.css';
import './styles/composer.css';
import './styles/markdown.css';
import './styles/dialog.css';
import './styles/settings.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { boot, handlePopState, startListPolling } from './actions';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { startStreamSync } from './streams';
import { startTheme } from './theme';

startTheme();
startStreamSync();
startListPolling();
window.addEventListener('popstate', handlePopState);

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('The page is missing its #root element.');

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

void boot();
