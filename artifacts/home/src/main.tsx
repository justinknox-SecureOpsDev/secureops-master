import { createRoot } from "react-dom/client";
import App from "./App";
import { loadBrand } from "./lib/brand";
import "./index.css";

// Front door → mobile web connect screen.
//
// ONE app-store build serves MANY customer backends. The mobile web app's
// /app/connect screen is where a visitor enters their organization code — and
// where App Store reviewers enter the demo code. In the single-VM production
// layout (marketing at "/", mobile web at "/app/" on the SAME origin) the bare
// front door therefore hands straight off to that connect screen instead of the
// marketing landing. We do this before React renders so there's no marketing
// flash, and scope it to the EXACT root path so every other marketing route
// (/pricing, /officer-app, …) is untouched. Guarded to production because in
// dev the marketing SPA runs standalone on its own port with no "/app/" mounted
// beside it. The served HTML is unchanged (the redirect is client-side JS), so
// the front-door build gate still sees the marketing shell at "/".
if (
  import.meta.env.PROD &&
  typeof window !== "undefined" &&
  window.location.pathname === "/"
) {
  window.location.replace("/app/connect");
} else {
  // Resolve the white-label brand before first paint so the wordmark and
  // footer render with the correct company name. Falls back to WCSG defaults
  // if /api/brand is unreachable.
  loadBrand().finally(() => {
    createRoot(document.getElementById("root")!).render(<App />);
  });
}
