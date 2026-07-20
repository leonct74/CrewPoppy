import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./poppy.css"; // the design kit's token sheet — must load before our own styles
import "./theme.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
