import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./ui/App.js";
import { createWorldRenderer } from "./world/create-world-renderer.js";
import "./styles.css";

const worldRoot = document.querySelector<HTMLElement>("#world-root");
const uiRoot = document.querySelector<HTMLElement>("#ui-root");

if (!worldRoot || !uiRoot) {
  throw new Error("Application shell roots are missing");
}

const worldRenderer = createWorldRenderer(worldRoot);
createRoot(uiRoot).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

window.addEventListener("beforeunload", () => worldRenderer.destroy(), {
  once: true,
});
