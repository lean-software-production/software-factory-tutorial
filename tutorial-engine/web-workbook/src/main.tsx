import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./activity-band.css";
import { App } from "./workbook-ui.js";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
