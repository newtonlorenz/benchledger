import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@fontsource-variable/ibm-plex-sans/wght.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles.css";
import "./workspace-design.css";
import { applyAppearance, readAppearance } from "./appearance";

applyAppearance(readAppearance());
const root = document.getElementById("root");
if (!root) throw new Error("BenchLedger root element is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
