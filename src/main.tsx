import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initClarity } from "./clarity";
import "./styles.css";

initClarity();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
