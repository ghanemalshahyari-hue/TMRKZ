import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../frontend/src/styles/fonts.css';
import 'leaflet/dist/leaflet.css';
import '../../../../frontend/src/styles/prototype.css';
import '../../../../frontend/src/styles/app.css';
// the polygon engine's own map styles, unchanged
import '../../../../frontend/src/styles/stationing.css';
import '../styles.css';
import './model.css';
import { ModelApp } from './ModelApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ModelApp />
  </StrictMode>,
);
