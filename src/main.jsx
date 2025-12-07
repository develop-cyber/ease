import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

async function start() {
  if (import.meta.env.DEV) {
    // start MSW and use the file that "msw init" placed in /public
    const { worker } = await import('./mocks/browser');
    await worker.start({ serviceWorker: { url: '/mockServiceWorker.js' } });
  }
  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
start();
