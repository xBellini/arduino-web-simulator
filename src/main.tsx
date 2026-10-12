/**
 * What: Vite client entry — mount React tree on #root. Imports ./index.css once, createRoot from react-dom/client,
 * renders <StrictMode><App /></StrictMode>. No routing or providers beyond what App adds. To change global boot
 * (error boundary, analytics): wrap App here sparingly. New top-level routes or layout: prefer App.tsx. Env types
 * and import.meta.env: vite-env.d.ts. Build config: vite.config — not main.tsx.
 *
 * Changelog:
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
