import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/index.css';
import './docs.css';
import { DocsPage } from './DocsPage';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DocsPage />
  </React.StrictMode>,
);
