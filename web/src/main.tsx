import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { APP_NAME } from '../../shared/defaults';

function App() {
  return <h1>{APP_NAME}</h1>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
