// Bundled IBM Plex (SIL OFL 1.1) replaces the mock's Google Fonts import.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-mono/700.css";
import "./styles/global.css";

import ReactDOM from "react-dom/client";

// The mock device must replace the Tauri IPC layer before any module
// reads it, so App (→ store → lib/tauri) is imported only afterwards.
async function bootstrap() {
  if (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).has("mock")
  ) {
    const { installMockDevice } = await import("./lib/mock-device");
    installMockDevice();
  }
  const { default: App } = await import("./App");

  // No StrictMode: the shell boots device discovery and a rAF stream clock
  // in mount effects; double-invocation would double the serial traffic.
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <App />,
  );
}

void bootstrap();
