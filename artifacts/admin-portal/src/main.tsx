import { createRoot } from "react-dom/client";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";
import { fetchBrand } from "./lib/brand";
import { getToken } from "./lib/api";

// Wire the generated API client (React Query hooks from @workspace/api-client-react)
// to the portal's stored admin token. Without this, every generated-hook request
// (dashboard summary, admin tasks, analytics, protection detail, UI preferences)
// goes out with NO Authorization header and is rejected with 401 even while the
// legacy `api()` / `fetchWithAuth` paths work fine. Registered at module scope so
// it is in place before any component renders or query fires.
setAuthTokenGetter(() => getToken());

// Kick off brand fetch immediately — it's quick (one JSON round-trip) and
// ensures window.__BRAND__ is populated before any component mounts.
fetchBrand().then(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
