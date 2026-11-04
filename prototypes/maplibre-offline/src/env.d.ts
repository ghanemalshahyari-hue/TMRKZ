// the frontend module imports the MapLibre worker as a Vite asset URL
declare module '*?url' {
  const url: string;
  export default url;
}
