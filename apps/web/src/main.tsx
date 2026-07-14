import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./ui/App.js";
import "./styles.css";

const worldRoot = document.querySelector<HTMLElement>("#world-root");
const uiRoot = document.querySelector<HTMLElement>("#ui-root");

if (!worldRoot || !uiRoot) {
  throw new Error("Application shell roots are missing");
}

createRoot(uiRoot).render(
  <StrictMode>
    <App worldRoot={worldRoot} />
  </StrictMode>,
);
