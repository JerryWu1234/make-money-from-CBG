import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AnalysisPreview } from "./AnalysisPreview";

const rootElement = document.getElementById("root");

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      {window.location.pathname === "/analysis-preview" ? <AnalysisPreview /> : <App />}
    </React.StrictMode>,
  );
}
