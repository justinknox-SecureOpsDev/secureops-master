import { useEffect, type ReactNode } from "react";
import { Link } from "wouter";
import { getBrand } from "@/lib/brand";
import { ShieldLogo } from "@/components/ShieldLogo";

interface Tier {
  name: string;
  tagline: string;
  price: ReactNode;
  cadence: string;
  highlight?: boolean;
  included: string[];
  notIncluded?: string[];
}

const tiers: Tier[] = [
  {
    name: "Starter",
    tagline: "Single-site or small operators (1–25 officers).",
    price: <><span className="apex-price__prefix">Starting at</span>$600<span className="apex-price__unit">/mo</span></>,
    cadence: "Billed monthly · 12-month commitment · ~15% off annual upfront",
    included: [
      "Scheduling (shifts, repeating series, open-vacancy claim)",
      "Time clock + geo clock-in",
      "Officer + admin mobile apps (under your brand)",
      "Basic dashboard & dispatch",
      "Clients, sites & licenses",
      "Email + push notifications",
    ],
    notIncluded: [
      "Chat, radio, incidents",
      "HR pipeline, onboarding, invitations",
      "Payroll & invoicing",
    ],
  },
  {
    name: "Professional",
    tagline: "Most security companies (25–150 officers).",
    price: <><span className="apex-price__prefix">Starting at</span>$900<span className="apex-price__unit">/mo</span></>,
    cadence: "Most popular · billed monthly · annual discount available",
    highlight: true,
    included: [
      "Everything in Starter, plus:",
      "Incident reporting + client share links",
      "Real-time chat (replaces WhatsApp groups)",
      "Live officer map + geofence breach alerts",
      "Daily activity reports",
      "Swap requests + officer availability",
      "Patrol checkpoints",
      "License renewal workflow",
      "Audit log",
    ],
    notIncluded: [
      "HR pipeline (public application + onboarding)",
      "Payroll execution & invoicing",
      "Push-to-talk radio",
    ],
  },
  {
    name: "Enterprise",
    tagline: "Multi-site operators, full back-office (150+ officers).",
    price: <><span className="apex-price__prefix">Starting at</span>$1,200<span className="apex-price__unit">/mo</span></>,
    cadence: "+ $4/officer/mo over 150 · everything enabled",
    included: [
      "Everything in Professional, plus:",
      "HR pipeline (application, onboarding, invitations)",
      "Payroll execution (Pay Run, ACH CSV, paystubs)",
      "Invoicing (auto-generated weekly, client-by-site)",
      "Push-to-talk radio",
      "Training certifications",
      "Bulk data exports",
      "Officer share links (external compliance)",
    ],
  },
];

const addons = [
  { name: "Stripe Connect direct deposits", price: "$99/mo", note: "Passes Stripe fees through" },
  { name: "Twilio SMS notifications", price: "$39/mo", note: "Plus Twilio usage at cost" },
  { name: "Dedicated subdomain + custom email FROM", price: "$25/mo", note: "Your domain on every link" },
  { name: "Additional sub-brand (multi-tenant white-label)", price: "$199/mo", note: "Per additional brand" },
];

const setup = [
  { service: "Branding kit", price: "$1,500", scope: "Logo, palette, App / Play Store icons, email header, login art. 2 revision rounds." },
  { service: "White-label deployment", price: "$2,500", scope: "Isolated environment, your domain, SSL, brand assets wired into mobile bundle." },
  { service: "Apple App Store distribution", price: "$1,200 + $99/yr", scope: "EAS build, App Store Connect setup, screenshots, review submission." },
  { service: "Google Play distribution", price: "$800 + $25 one-time", scope: "EAS build, Play Console setup, screenshots, review submission." },
  { service: "Data migration (basic)", price: "$750", scope: "CSV import up to 500 employees + 50 clients + 200 sites." },
  { service: "Data migration (large)", price: "$2,000+", scope: "Custom ETL from prior system (Deputy, When I Work, ABM, etc.). Quoted per source." },
  { service: "Admin training (live)", price: "$600", scope: "Two 90-minute Zoom sessions for admin staff. Recorded for reuse." },
  { service: "Officer training (video pack)", price: "$400", scope: "Branded officer onboarding video (clock-in, incidents, chat, panic button)." },
  { service: "On-site go-live support", price: "$1,800/day", scope: "Optional. Travel billed at cost." },
];

const ongoing = [
  { service: "Premium support", price: "$399/mo", scope: "4-hour SLA in business hours · dedicated Slack channel" },
  { service: "Quarterly health check + tuning", price: "$250/mo", scope: "Performance review, config audit, optimization recommendations" },
  { service: "Custom integrations", price: "$500–2,500 + $100/mo", scope: "One-time build + monthly upkeep, per integration" },
  { service: "Priority feature requests", price: "$150/hr", scope: "Or fixed quote for scoped work" },
];

export default function Pricing() {
  useEffect(() => {
    window.scrollTo(0, 0);
    const prev = document.title;
    document.title = "SecureOps — Pricing";
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <div className="apex-shell">
      <div className="apex-bg-grid" aria-hidden="true" />
      <div className="apex-bg-glow apex-bg-glow--gold" aria-hidden="true" />
      <div className="apex-bg-glow apex-bg-glow--navy" aria-hidden="true" />

      <header className="apex-header">
        <Link href="/" className="apex-brand">
          <ShieldLogo className="apex-brand__mark" />
          <div className="apex-brand__wordmark">
            <span className="apex-brand__name">{getBrand().appName}</span>
            <span className="apex-brand__tag">Workforce Operations Suite</span>
          </div>
        </Link>
        <nav className="apex-header__nav">
          <Link className="apex-header__link" href="/">&larr; Home</Link>
          <Link className="apex-header__link apex-header__link--gold" href="/get-started?source=pricing_header">Talk to sales &rarr;</Link>
        </nav>
      </header>

      <main className="apex-main apex-main--feature">
        <section className="apex-hero apex-hero--feature">
          <span className="apex-eyebrow">
            <span className="apex-dot" /> Pricing schedule
          </span>
          <h1 className="apex-hero__title">
            Transparent pricing.<br />
            <span className="apex-gold">Built for security operators.</span>
          </h1>
          <p className="apex-hero__sub">
            One codebase, three tiers. Pick the surface area that matches your operation today — upgrade in place when you grow. Prices in USD, per-company, billed monthly with a 12-month commitment.
          </p>
        </section>

        <section className="apex-price-grid">
          {tiers.map((t) => (
            <article key={t.name} className={`apex-price-card ${t.highlight ? "apex-price-card--featured" : ""}`}>
              {t.highlight && <span className="apex-price-card__badge">Most popular</span>}
              <header className="apex-price-card__head">
                <h2 className="apex-price-card__name">{t.name}</h2>
                <p className="apex-price-card__tag">{t.tagline}</p>
                <div className="apex-price-card__price">{t.price}</div>
                <p className="apex-price-card__cadence">{t.cadence}</p>
              </header>
              <ul className="apex-price-card__list">
                {t.included.map((line) => (
                  <li key={line} className="apex-price-card__item apex-price-card__item--in">
                    <span className="apex-price-card__check" aria-hidden="true">✓</span>
                    <span>{line}</span>
                  </li>
                ))}
                {t.notIncluded?.map((line) => (
                  <li key={line} className="apex-price-card__item apex-price-card__item--out">
                    <span className="apex-price-card__check" aria-hidden="true">—</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              <Link
                className={`apex-cta apex-cta--inline apex-price-card__cta ${t.highlight ? "apex-cta--gold" : "apex-cta--outline"}`}
                href={`/get-started?tier=${encodeURIComponent(t.name)}&source=pricing_${t.name.toLowerCase()}`}
              >
                <div className="apex-cta__head">
                  <span className="apex-cta__label">Choose {t.name}</span>
                  <span className="apex-cta__arrow" aria-hidden="true">&rarr;</span>
                </div>
              </Link>
            </article>
          ))}
        </section>

        <section className="apex-price-section">
          <div className="apex-price-section__head">
            <h2 className="apex-price-section__title">Add-ons</h2>
            <p className="apex-price-section__sub">Available on any tier. Toggle on or off any month.</p>
          </div>
          <div className="apex-price-table">
            {addons.map((a) => (
              <div key={a.name} className="apex-price-row apex-price-row--noprice">
                <div className="apex-price-row__name">{a.name}</div>
                <div className="apex-price-row__scope">{a.note}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="apex-price-section">
          <div className="apex-price-section__head">
            <h2 className="apex-price-section__title">Setup &amp; onboarding</h2>
            <p className="apex-price-section__sub">One-time, before your monthly subscription starts. Onboarding costs <strong className="apex-gold">vary based on your plan and add-ons</strong>.</p>
          </div>
          <div className="apex-price-table">
            {setup.map((s) => (
              <div key={s.service} className="apex-price-row apex-price-row--noprice">
                <div className="apex-price-row__name">{s.service}</div>
                <div className="apex-price-row__scope">{s.scope}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="apex-price-section">
          <div className="apex-price-section__head">
            <h2 className="apex-price-section__title">Ongoing services</h2>
            <p className="apex-price-section__sub">Optional, monthly. Add at any time.</p>
          </div>
          <div className="apex-price-table">
            {ongoing.map((s) => (
              <div key={s.service} className="apex-price-row">
                <div className="apex-price-row__name">{s.service}</div>
                <div className="apex-price-row__price">{s.price}</div>
                <div className="apex-price-row__scope">{s.scope}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="apex-feature-final">
          <h2 className="apex-feature-final__title">Ready to scope a quote?</h2>
          <p className="apex-feature-final__sub">Tell us your officer count, number of sites, and whether you need HR + payroll. We'll send back a one-page proposal within one business day.</p>
          <Link className="apex-cta apex-cta--gold apex-cta--inline" href="/get-started?source=pricing_footer">
            <div className="apex-cta__head">
              <span className="apex-cta__label">Request a proposal</span>
              <span className="apex-cta__arrow" aria-hidden="true">&rarr;</span>
            </div>
          </Link>
        </section>
      </main>

      <footer className="apex-footer">
        <Link className="apex-footer__link" href="/">&larr; Back to home</Link>
        <span className="apex-footer__sep" aria-hidden="true">&middot;</span>
        <a className="apex-footer__link" href="/admin-portal/privacy">Privacy</a>
        <a className="apex-footer__link" href="/admin-portal/terms">Terms</a>
      </footer>
    </div>
  );
}
