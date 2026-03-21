import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import '@webview/index.css';
import './styles/web-theme.css';

// Polyfill crypto.randomUUID for non-secure contexts (HTTP).
// Mobile browsers only expose randomUUID() over HTTPS, but
// crypto.getRandomValues() works everywhere.
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = () =>
    '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => {
      const n = Number(c);
      return (n ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (n / 4)))).toString(16);
    }) as `${string}-${string}-${string}-${string}-${string}`;
}

localStorage.setItem('editor', JSON.stringify('web'));
document.documentElement.dataset.editor = 'web';
window.mediaUrl = '';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
