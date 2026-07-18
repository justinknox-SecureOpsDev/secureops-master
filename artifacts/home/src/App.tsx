import { Link, Route, Switch, Router as WouterRouter } from "wouter";
import Home from "./pages/Home";
import AdminPortalFeatures from "./pages/AdminPortalFeatures";
import OfficerAppFeatures from "./pages/OfficerAppFeatures";
import Pricing from "./pages/Pricing";
import GetStarted from "./pages/GetStarted";

function NotFound() {
  return (
    <div className="apex-shell" style={{ display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "80px 20px" }}>
      <div>
        <h1 className="apex-hero__title" style={{ fontSize: 48 }}>Page not found</h1>
        <p className="apex-hero__sub">The page you're looking for doesn't exist.</p>
        <Link className="apex-cta apex-cta--gold apex-cta--inline" href="/">
          <div className="apex-cta__head">
            <span className="apex-cta__label">Back to home</span>
            <span className="apex-cta__arrow" aria-hidden="true">&rarr;</span>
          </div>
        </Link>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/admin-portal" component={AdminPortalFeatures} />
        <Route path="/officer-app" component={OfficerAppFeatures} />
        <Route path="/pricing" component={Pricing} />
        <Route path="/get-started" component={GetStarted} />
        <Route component={NotFound} />
      </Switch>
    </WouterRouter>
  );
}
