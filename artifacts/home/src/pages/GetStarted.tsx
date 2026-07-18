import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { getBrand } from "@/lib/brand";
import { ShieldLogo } from "@/components/ShieldLogo";

const TIER_OPTIONS = [
  { value: "", label: "Not sure yet — help me choose" },
  { value: "Starter", label: "Starter — 1–25 officers (from $600/mo)" },
  { value: "Professional", label: "Professional — 25–150 officers (from $900/mo)" },
  { value: "Enterprise", label: "Enterprise — 150+ officers (from $1,200/mo)" },
];

const VALID_TIERS = new Set(["Starter", "Professional", "Enterprise"]);

/** Read ?tier= and ?source= from the URL once on mount. */
function readQuery(): { tier: string; source: string } {
  if (typeof window === "undefined") return { tier: "", source: "" };
  const params = new URLSearchParams(window.location.search);
  const rawTier = (params.get("tier") ?? "").trim();
  const tier = VALID_TIERS.has(rawTier) ? rawTier : "";
  const source = (params.get("source") ?? "").trim();
  return { tier, source };
}

type Status = "idle" | "submitting" | "success" | "error";

export default function GetStarted() {
  const initial = useMemo(readQuery, []);
  const [companyName, setCompanyName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [officerCount, setOfficerCount] = useState("");
  const [tier, setTier] = useState(initial.tier);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    window.scrollTo(0, 0);
    const prev = document.title;
    document.title = `${getBrand().appName} — Get started`;
    return () => {
      document.title = prev;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "submitting") return;
    setStatus("submitting");
    setErrorMsg("");
    try {
      const body: Record<string, unknown> = {
        companyName: companyName.trim(),
        contactName: contactName.trim(),
        email: email.trim(),
        source: initial.source || "marketing_site",
      };
      if (phone.trim()) body.phone = phone.trim();
      if (tier) body.tier = tier;
      if (message.trim()) body.message = message.trim();
      if (officerCount.trim()) body.officerCount = Number(officerCount.trim());

      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = "Something went wrong. Please try again or email us directly.";
        try {
          const data = await res.json();
          if (res.status === 429) msg = "Too many requests. Please wait a few minutes and try again.";
          else if (data?.message && res.status === 400) msg = "Please check the form and try again.";
        } catch {
          // non-JSON error body — keep generic message
        }
        setErrorMsg(msg);
        setStatus("error");
        return;
      }
      setStatus("success");
    } catch {
      setErrorMsg("We couldn't reach the server. Please check your connection and try again.");
      setStatus("error");
    }
  }

  const appName = getBrand().appName;

  return (
    <div className="apex-shell">
      <div className="apex-bg-grid" aria-hidden="true" />
      <div className="apex-bg-glow apex-bg-glow--gold" aria-hidden="true" />
      <div className="apex-bg-glow apex-bg-glow--navy" aria-hidden="true" />

      <header className="apex-header">
        <Link href="/" className="apex-brand">
          <ShieldLogo className="apex-brand__mark" />
          <div className="apex-brand__wordmark">
            <span className="apex-brand__name">{appName}</span>
            <span className="apex-brand__tag">Workforce Operations Suite</span>
          </div>
        </Link>
        <nav className="apex-header__nav">
          <Link className="apex-header__link" href="/">&larr; Home</Link>
          <Link className="apex-header__link" href="/pricing">Pricing</Link>
        </nav>
      </header>

      <main className="apex-main apex-main--feature">
        <section className="apex-hero apex-hero--feature">
          <span className="apex-eyebrow">
            <span className="apex-dot" /> Request access
          </span>
          <h1 className="apex-hero__title">
            Let's get your operation <span className="apex-gold">on {appName}</span>.
          </h1>
          <p className="apex-hero__sub">
            Tell us a little about your company and we'll send back a tailored proposal —
            including setup, timeline, and pricing — within one business day.
          </p>
        </section>

        <section className="apex-leadform-wrap">
          {status === "success" ? (
            <div className="apex-leadform apex-leadform--success" role="status">
              <div className="apex-leadform__success-mark" aria-hidden="true">✓</div>
              <h2 className="apex-leadform__success-title">Request received</h2>
              <p className="apex-leadform__success-sub">
                Thanks, {contactName.trim().split(/\s+/)[0] || "there"}. We've got your details
                {tier ? <> and noted your interest in the <strong className="apex-gold">{tier}</strong> plan</> : null}.
                A member of our team will be in touch within one business day.
              </p>
              <Link className="apex-cta apex-cta--gold apex-cta--inline" href="/">
                <div className="apex-cta__head">
                  <span className="apex-cta__label">Back to home</span>
                  <span className="apex-cta__arrow" aria-hidden="true">&rarr;</span>
                </div>
              </Link>
            </div>
          ) : (
            <form className="apex-leadform" onSubmit={handleSubmit} noValidate>
              <div className="apex-field">
                <label className="apex-field__label" htmlFor="lf-company">Company name<span className="apex-field__req" aria-hidden="true"> *</span></label>
                <input
                  id="lf-company" className="apex-field__input" type="text" required
                  autoComplete="organization" value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)} placeholder="Acme Security LLC"
                />
              </div>

              <div className="apex-field-row">
                <div className="apex-field">
                  <label className="apex-field__label" htmlFor="lf-name">Your name<span className="apex-field__req" aria-hidden="true"> *</span></label>
                  <input
                    id="lf-name" className="apex-field__input" type="text" required
                    autoComplete="name" value={contactName}
                    onChange={(e) => setContactName(e.target.value)} placeholder="Jordan Williams"
                  />
                </div>
                <div className="apex-field">
                  <label className="apex-field__label" htmlFor="lf-email">Work email<span className="apex-field__req" aria-hidden="true"> *</span></label>
                  <input
                    id="lf-email" className="apex-field__input" type="email" required
                    autoComplete="email" value={email}
                    onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcompany.com"
                  />
                </div>
              </div>

              <div className="apex-field-row">
                <div className="apex-field">
                  <label className="apex-field__label" htmlFor="lf-phone">Phone <span className="apex-field__opt">(optional)</span></label>
                  <input
                    id="lf-phone" className="apex-field__input" type="tel"
                    autoComplete="tel" value={phone}
                    onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 123 4567"
                  />
                </div>
                <div className="apex-field">
                  <label className="apex-field__label" htmlFor="lf-officers">Officer count <span className="apex-field__opt">(optional)</span></label>
                  <input
                    id="lf-officers" className="apex-field__input" type="number" min={0} inputMode="numeric"
                    value={officerCount}
                    onChange={(e) => setOfficerCount(e.target.value)} placeholder="e.g. 60"
                  />
                </div>
              </div>

              <div className="apex-field">
                <label className="apex-field__label" htmlFor="lf-tier">Plan you're interested in</label>
                <select
                  id="lf-tier" className="apex-field__input apex-field__select" value={tier}
                  onChange={(e) => setTier(e.target.value)}
                >
                  {TIER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div className="apex-field">
                <label className="apex-field__label" htmlFor="lf-message">Anything else? <span className="apex-field__opt">(optional)</span></label>
                <textarea
                  id="lf-message" className="apex-field__input apex-field__textarea" rows={4}
                  value={message} onChange={(e) => setMessage(e.target.value)}
                  placeholder="Number of sites, must-have features, target go-live date…"
                />
              </div>

              {status === "error" && (
                <p className="apex-field__error" role="alert">{errorMsg}</p>
              )}

              <button className="apex-leadform__submit" type="submit" disabled={status === "submitting"}>
                {status === "submitting" ? "Sending…" : "Request access"}
                <span className="apex-cta__arrow" aria-hidden="true">&rarr;</span>
              </button>

              <p className="apex-leadform__fineprint">
                By submitting, you agree to be contacted about {appName}. See our{" "}
                <a className="apex-footer__link" href="/admin-portal/privacy">privacy policy</a>.
              </p>
            </form>
          )}
        </section>
      </main>

      <footer className="apex-footer">
        <Link className="apex-footer__link" href="/">&larr; Back to home</Link>
        <span className="apex-footer__sep" aria-hidden="true">&middot;</span>
        <Link className="apex-footer__link" href="/pricing">Pricing</Link>
        <a className="apex-footer__link" href="/admin-portal/privacy">Privacy</a>
        <a className="apex-footer__link" href="/admin-portal/terms">Terms</a>
      </footer>
    </div>
  );
}
