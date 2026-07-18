import { useEffect, useState } from "react";
import { Link } from "wouter";
import { getBrand } from "@/lib/brand";
import { ShieldLogo } from "@/components/ShieldLogo";

const EVENT_SCHEDULER_URL = "https://eventstaffscheduler.net";

export default function Home() {
  const [year, setYear] = useState(2026);
  useEffect(() => {
    setYear(new Date().getFullYear());
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
          <a className="apex-header__link" href="#products">Products</a>
          <Link className="apex-header__link" href="/pricing">Pricing</Link>
          <Link className="apex-header__link" href="/admin-portal">Admin</Link>
          <Link className="apex-header__link" href="/officer-app">Officer</Link>
        </nav>
      </header>

      <main className="apex-main">
        <section className="apex-hero">
          <span className="apex-eyebrow">
            <span className="apex-dot" /> Built by security teams, for security teams.
          </span>
          <h1 className="apex-hero__title">
            Built for the people who staff the <span className="apex-gold">front line</span>.
          </h1>
          <p className="apex-hero__sub">
            SecureOps runs your everyday security operation &mdash; recruitment, scheduling,
            live ops, payroll, and invoicing. EventStaffScheduler handles the spikes &mdash;
            large-format events, festivals, and one-off deployments. Pick where you want to go.
          </p>
          <div className="apex-hero__cta-row">
            <Link className="apex-cta apex-cta--gold apex-cta--inline" href="/get-started?source=hero">
              <div className="apex-cta__head">
                <span className="apex-cta__label">Request access</span>
                <span className="apex-cta__arrow" aria-hidden="true">&rarr;</span>
              </div>
            </Link>
            <Link className="apex-cta apex-cta--outline apex-cta--inline" href="/pricing">
              <div className="apex-cta__head">
                <span className="apex-cta__label">See pricing</span>
                <span className="apex-cta__arrow" aria-hidden="true">&rarr;</span>
              </div>
            </Link>
          </div>
        </section>

        <section id="products" className="apex-products">
          <article className="apex-product apex-product--primary">
            <header className="apex-product__head">
              <div className="apex-product__title-row">
                <ShieldLogo className="apex-product__mark" />
                <div>
                  <h2 className="apex-product__title">SecureOps</h2>
                  <p className="apex-product__kicker">Security Operations Platform</p>
                </div>
              </div>
              <span className="apex-product__badge">This site</span>
            </header>

            <p className="apex-product__desc">
              The end-to-end platform for private security companies. Hire officers, schedule
              shifts against client sites, track live field operations, approve hours, run
              payroll, and bill clients &mdash; all in one place.
            </p>

            <ul className="apex-product__bullets">
              <li>Officer recruitment, onboarding &amp; license tracking</li>
              <li>Site scheduling with pay &amp; bill rates and license gating</li>
              <li>Live officer map, geofenced clock-in, panic button</li>
              <li>Auto-built weekly payroll runs &amp; client invoices</li>
            </ul>

            <div className="apex-cta-row">
              <Link className="apex-cta apex-cta--gold" href="/admin-portal">
                <div className="apex-cta__head">
                  <span className="apex-cta__label">Admin Portal</span>
                  <span className="apex-cta__arrow" aria-hidden="true">&rarr;</span>
                </div>
                <span className="apex-cta__desc">
                  See the features &mdash; dispatch, HR, payroll, audit.
                </span>
              </Link>

              <Link className="apex-cta apex-cta--outline" href="/officer-app">
                <div className="apex-cta__head">
                  <span className="apex-cta__label">Officer App</span>
                  <span className="apex-cta__arrow" aria-hidden="true">&rarr;</span>
                </div>
                <span className="apex-cta__desc">
                  See the features &mdash; shifts, clock in, emergencies, chat.
                </span>
              </Link>
            </div>

          </article>

          <article className="apex-product apex-product--secondary">
            <header className="apex-product__head">
              <div className="apex-product__title-row">
                <div className="apex-product__mark apex-product__mark--ess" aria-hidden="true">
                  <span>ESS</span>
                </div>
                <div>
                  <h2 className="apex-product__title">EventStaffScheduler</h2>
                  <p className="apex-product__kicker">Event &amp; Crowd Staffing</p>
                </div>
              </div>
              <span className="apex-product__badge apex-product__badge--alt">Sister product</span>
            </header>

            <p className="apex-product__desc">
              Purpose-built for event security and crowd staffing. Spin up a deployment for a
              single show or a 30-day festival, post calls for hundreds of officers, and
              coordinate check-in, post assignments, and payouts the same day.
            </p>

            <ul className="apex-product__bullets">
              <li>Event-by-event posting with role &amp; post counts</li>
              <li>Bulk officer call-outs, RSVP and waitlist management</li>
              <li>On-site check-in, post assignment &amp; head-count</li>
              <li>Same-day payouts &amp; per-event client invoicing</li>
            </ul>

            <div className="apex-cta-row apex-cta-row--single">
              <a
                className="apex-cta apex-cta--gold"
                href={EVENT_SCHEDULER_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <div className="apex-cta__head">
                  <span className="apex-cta__label">Visit EventStaffScheduler.net</span>
                  <span className="apex-cta__arrow" aria-hidden="true">&rarr;</span>
                </div>
                <span className="apex-cta__desc">
                  Opens the EventStaffScheduler site in a new tab.
                </span>
              </a>
            </div>

            <p className="apex-product__note">
              <a
                className="apex-product__link"
                href={EVENT_SCHEDULER_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                eventstaffscheduler.net &rarr;
              </a>
            </p>
          </article>
        </section>
      </main>

      <footer className="apex-footer">
        <span>
          &copy; {year} {getBrand().companyName}. All rights reserved.
          {getBrand().companyLicense ? <> &middot; {getBrand().companyLicense}</> : null}
        </span>
        <span className="apex-footer__sep" aria-hidden="true">&middot;</span>
        <Link className="apex-footer__link" href="/pricing">Pricing</Link>
        <a className="apex-footer__link" href="/admin-portal/privacy">Privacy</a>
        <a className="apex-footer__link" href="/admin-portal/terms">Terms</a>
        <a className="apex-footer__link" href="/admin-portal/data-rights">Data rights</a>
      </footer>
    </div>
  );
}
