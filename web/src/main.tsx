import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { WatchedCodesProvider } from "./useWatchedCodes";
import "./styles.css";
import "./overview.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WatchedCodesProvider>
      <App />
    </WatchedCodesProvider>
  </React.StrictMode>,
);
