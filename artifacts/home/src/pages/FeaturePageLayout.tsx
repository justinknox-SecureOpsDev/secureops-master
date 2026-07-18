import { useEffect, type ReactNode } from "react";
import { Link } from "wouter";
import { getBrand } from "@/lib/brand";
import { ShieldLogo } from "@/components/ShieldLogo";

export interface FeatureItem {
  title: string;
  description: string;
  image: string;
  alt: string;
  edge: string;
}

export interface FeaturePageProps {
  eyebrow: string;
  title: ReactNode;
  intro: string;
  features: FeatureItem[];
  ctaLabel: string;
  ctaHref: string;
  ctaNote: string;
  imageOrientation: "wide" | "phone";
}

export default function FeaturePageLayout({
  eyebrow,
  title,
  intro,
  features,
  ctaLabel,
  ctaHref,
  ctaNote,
  imageOrientation,
}: FeaturePageProps) {
  useEffect(() => {
    window.scrollTo(0, 0);
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
          <Link className="apex-header__link" href="/pricing">Pricing</Link>
          <a className="apex-header__link apex-header__link--gold" href={ctaHref}>{ctaLabel} &rarr;</a>
        </nav>
      </header>

      <main className="apex-main apex-main--feature">
        <section className="apex-hero apex-hero--feature">
          <span className="apex-eyebrow">
            <span className="apex-dot" /> {eyebrow}
          </span>
          <h1 className="apex-hero__title">{title}</h1>
          <p className="apex-hero__sub">{intro}</p>

          <div className="apex-cta-row apex-cta-row--single">
            <a className="apex-cta apex-cta--gold" href={ctaHref}>
              <div className="apex-cta__head">
                <span className="apex-cta__label">{ctaLabel}</span>
                <span className="apex-cta__arrow" aria-hidden="true">&rarr;</span>
              </div>
              <span className="apex-cta__desc">{ctaNote}</span>
            </a>
          </div>
        </section>

        <section className={`apex-feature-stack apex-feature-stack--${imageOrientation}`}>
          {features.map((f, i) => (
            <article
              key={f.title}
              className={`apex-feature-row ${i % 2 === 1 ? "apex-feature-row--reverse" : ""}`}
            >
              <div className="apex-feature-row__media">
                <div className={`apex-feature-row__frame apex-feature-row__frame--${imageOrientation}`}>
                  <img src={f.image} alt={f.alt} loading="lazy" />
                </div>
              </div>
              <div className="apex-feature-row__body">
                <span className="apex-feature-row__index">0{i + 1}</span>
                <h2 className="apex-feature-row__title">{f.title}</h2>
                <p className="apex-feature-row__desc">{f.description}</p>
                <div className="apex-feature-row__edge">
                  <span className="apex-feature-row__edge-label">The SecureOps edge</span>
                  <p className="apex-feature-row__edge-text">{f.edge}</p>
                </div>
              </div>
            </article>
          ))}
        </section>

        <section className="apex-feature-final">
          <h2 className="apex-feature-final__title">Ready to see it live?</h2>
          <p className="apex-feature-final__sub">{ctaNote}</p>
          <a className="apex-cta apex-cta--gold apex-cta--inline" href={ctaHref}>
            <div className="apex-cta__head">
              <span className="apex-cta__label">{ctaLabel}</span>
              <span className="apex-cta__arrow" aria-hidden="true">&rarr;</span>
            </div>
          </a>
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
