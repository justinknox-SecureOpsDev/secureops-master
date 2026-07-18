import FeaturePageLayout, { type FeatureItem } from "./FeaturePageLayout";

const BASE = import.meta.env.BASE_URL;

const features: FeatureItem[] = [
  {
    title: "My Shifts — the only screen an officer needs",
    description:
      "Officers see every upcoming shift, the site, the call time, and the pay rate up front. Tap to reserve open vacancies they're licensed for. No phone tag with dispatch, no back-and-forth texts.",
    edge: "Most guard-tour apps make officers log in to a portal to find their schedule. SecureOps puts it on the lock screen.",
    image: `${BASE}features/officer-shifts.png`,
    alt: "Officer mobile app My Shifts screen showing confirmed upcoming shift cards with clearance level, call times, and gold pay-rate badges",
  },
  {
    title: "Geofenced clock-in — no time theft, no awkward chases",
    description:
      "The clock-in button only goes green when the officer is physically on site. Hours roll up to payroll automatically. If they drift outside the perimeter, dispatch gets a push and an SMS in seconds.",
    edge: "Honest officers love it (no questions asked about their hours). Operators love it (no more billing clients for hours that didn't happen).",
    image: `${BASE}features/officer-clockin.png`,
    alt: "Officer Time Clock screen with an off-duty timer ring, a live GPS location fix, and a large green clock-in button",
  },
  {
    title: "Panic button that actually reaches someone",
    description:
      "Hold for three seconds, and every admin gets a push, an SMS, and a critical incident in the dashboard — while the officer's phone is already dialing your emergency number. No menus, no forms, no fumbling.",
    edge: "Designed for one-handed use in the worst three seconds of a shift. Tested by working officers, not by product managers.",
    image: `${BASE}features/officer-emergency.png`,
    alt: "Officer app home screen with a red emergency panic bar across the top, weekly hours stats, next shift, and quick actions",
  },
  {
    title: "Team chat that replaces the WhatsApp group",
    description:
      "Real-time channels for ops, per-site rooms, license-level rooms, and direct messages. History is persistent and searchable — so the next shift on post can scroll back through what happened on the last one.",
    edge: "Your incident history stops living on someone's personal phone. When an officer leaves, the conversation doesn't leave with them.",
    image: `${BASE}features/officer-chat.png`,
    alt: "Officer team chat screen showing a per-site channel with message bubbles, gold-tinted sender names, and timestamps",
  },
];

export default function OfficerAppFeatures() {
  return (
    <FeaturePageLayout
      eyebrow="The Officer App"
      title={
        <>
          Everything an officer needs, <span className="apex-gold">in their pocket</span>.
        </>
      }
      intro="The SecureOps Officer App is built for the people doing the work — fast, one-handed, and ruthlessly focused on what matters during a shift."
      features={features}
      ctaLabel="Open the Officer App"
      ctaHref="/"
      ctaNote="Sign in on your phone or open the web build to try the officer experience."
      imageOrientation="phone"
    />
  );
}
