import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../frontend/src/styles/fonts.css';
import 'leaflet/dist/leaflet.css';
import '../../../../frontend/src/styles/prototype.css';
// the polygon engine's own map styles, unchanged
import '../../../../frontend/src/styles/stationing.css';
import './v3.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
