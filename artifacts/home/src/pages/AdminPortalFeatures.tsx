import FeaturePageLayout, { type FeatureItem } from "./FeaturePageLayout";

const BASE = import.meta.env.BASE_URL;

const features: FeatureItem[] = [
  {
    title: "Live officer map — not a 30-minute-old report",
    description:
      "Every clocked-in officer pings the platform once a minute. Dispatch sees who is on post, who is roaming, and who is geofence-breaching the moment it happens. One click to call, one click to chat.",
    edge: "Most security software gives you a printable schedule. SecureOps gives you the live picture, on one screen, with no refresh button.",
    image: `${BASE}features/admin-live-map.png`,
    alt: "Live officer map showing pin markers and geofence circles on a navy dashboard",
  },
  {
    title: "Scheduling with pay rate, bill rate, and license gating",
    description:
      "Post a shift against a client site with hourly pay, hourly bill, headcount, and a minimum license level. Officers self-claim from their phone — the system blocks anyone under-qualified before the lawyer ever needs to look.",
    edge: "Built-in pay/bill margin tracking and license enforcement — not bolted on as a paid add-on like the legacy guard tour vendors.",
    image: `${BASE}features/admin-scheduling.png`,
    alt: "Weekly shift schedule grid with color-coded shifts and a site sidebar",
  },
  {
    title: "Payroll & invoicing that build themselves",
    description:
      "Approved time entries flow straight into a weekly payroll run and an auto-built client invoice. Export an ACH-ready CSV in one click, mark paid when the bank confirms, and watch the audit trail capture every approval.",
    edge: "End the spreadsheet shuffle. No more re-keying hours into payroll and then again into QuickBooks — one approval drives both.",
    image: `${BASE}features/admin-payroll.png`,
    alt: "Payroll run dashboard with officer table and gold-highlighted USD totals",
  },
  {
    title: "From applicant to active officer, in one pipeline",
    description:
      "Public application page, license verification, multi-step onboarding, signed acknowledgements, and document storage. Approving an applicant provisions their officer account and emails their onboarding link in the same click.",
    edge: "No more chasing PDFs over email. Every applicant, license, and signed form lives in one auditable place — not in a shared inbox.",
    image: `${BASE}features/admin-hr.png`,
    alt: "HR applicant pipeline kanban board with cards in New, Under Review, Approved columns",
  },
];

export default function AdminPortalFeatures() {
  return (
    <FeaturePageLayout
      eyebrow="The Admin Portal"
      title={
        <>
          Run the whole operation from <span className="apex-gold">one screen</span>.
        </>
      }
      intro="The SecureOps Admin Portal is where dispatch, HR, and payroll converge. Below are the four surfaces operators ask us about most — and where we leave the legacy guard-tour vendors behind."
      features={features}
      ctaLabel="Open the Admin Portal"
      ctaHref="/admin-portal/"
      ctaNote="Sign in with your admin credentials to launch the live portal."
      imageOrientation="wide"
    />
  );
}
