import L from 'leaflet';

// Leaflet-Geoman (loaded on demand by the boundary editor) attaches itself to the global `L`.
(window as unknown as { L: typeof L }).L = L;

export default L;
