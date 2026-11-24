import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DevChat } from "./DevChat";
import { initClarity } from "./clarity";
import "./styles.css";

const devChat =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get("dev") === "chat";
if (!devChat) initClarity();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {devChat ? <DevChat /> : <App />}
  </StrictMode>,
);
