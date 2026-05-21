import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { fetchBrand } from "./lib/brand";

// Kick off brand fetch immediately — it's quick (one JSON round-trip) and
// ensures window.__BRAND__ is populated before any component mounts.
fetchBrand().then(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
