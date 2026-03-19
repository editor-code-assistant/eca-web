import React from 'react';
import ReactDOM from 'react-dom/client';
import { RemotePage } from './pages/RemotePage';
import '@webview/index.css';
import './styles/web-theme.css';

localStorage.setItem('editor', JSON.stringify('web'));
document.documentElement.dataset.editor = 'web';
window.mediaUrl = '';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RemotePage />
  </React.StrictMode>,
);
