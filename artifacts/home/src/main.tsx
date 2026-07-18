import { createRoot } from "react-dom/client";
import App from "./App";
import { loadBrand } from "./lib/brand";
import "./index.css";

// Resolve the white-label brand before first paint so the wordmark and
// footer render with the correct company name. Falls back to WCSG defaults
// if /api/brand is unreachable.
loadBrand().finally(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
