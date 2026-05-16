import { Link } from "wouter";

const COMPANY = "Williams Council Security Group Inc.";
const SHORT = "WCSG";
const CONTACT_EMAIL = "privacy@williamscouncilsecurity.com";
const POSTAL = "Williams Council Security Group Inc., Texas, USA";

function Page({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#f0e6c8] text-[#080c18]">
      <header className="bg-[#080c18] text-white">
        <div className="max-w-3xl mx-auto px-6 py-6 flex items-center gap-3">
          <img
            src={`${import.meta.env.BASE_URL}logo-256.png`}
            alt="WCSG"
            className="w-10 h-10 rounded-md object-contain"
          />
          <div>
            <div className="brand-wordmark text-sm leading-tight">{COMPANY}</div>
            <div className="text-[10px] uppercase tracking-widest opacity-70">Legal</div>
          </div>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-3xl font-serif mb-1">{title}</h1>
        <p className="text-xs uppercase tracking-widest opacity-60 mb-8">
          Last updated {updated}
        </p>
        <article className="prose prose-sm max-w-none [&_h2]:font-serif [&_h2]:text-xl [&_h2]:mt-8 [&_h2]:mb-3 [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_a]:text-[#c9a84c] [&_a]:underline">
          {children}
        </article>
        <div className="mt-12 pt-6 border-t border-[#080c18]/20 flex flex-wrap items-center gap-4 text-xs">
          <Link href="/privacy" className="hover:underline">Privacy</Link>
          <Link href="/terms" className="hover:underline">Terms of Service</Link>
          <Link href="/data-rights" className="hover:underline">Your Data Rights</Link>
          <span className="opacity-50 ml-auto">© {new Date().getFullYear()} {SHORT}</span>
        </div>
      </main>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <Page title="Privacy Policy" updated="May 2026">
      <p>
        {COMPANY} ("{SHORT}", "we", "us") respects your privacy. This policy explains
        what information we collect through our SecureOps platform (the website,
        admin portal, and mobile app), how we use it, and the choices you have.
      </p>

      <h2>1. Information we collect</h2>
      <ul>
        <li>
          <strong>Account &amp; identity:</strong> name, email, phone, role,
          password hash, login activity, and (for officers) profile photo.
        </li>
        <li>
          <strong>Employment information:</strong> address, date of birth, last
          four digits of SSN, right-to-work and Texas security license details,
          uploaded documents (CV, photo ID, training certificates, passport),
          uniform sizes, and emergency contact.
        </li>
        <li>
          <strong>Payroll &amp; tax:</strong> bank account name, routing and
          account numbers, direct-deposit consent, signature, W-2/pay-stub
          documents, and pay-run history.
        </li>
        <li>
          <strong>Operational data:</strong> shift assignments, GPS-verified
          clock-in/out events, incident reports (text + photo attachments),
          team-chat messages, and live location pings while clocked in.
        </li>
        <li>
          <strong>Device &amp; technical:</strong> IP address, user-agent,
          push-notification token, and standard server logs.
        </li>
      </ul>

      <h2>2. How we use information</h2>
      <ul>
        <li>To operate the platform and provide security services to clients.</li>
        <li>To verify identity, eligibility, and licensing for assignments.</li>
        <li>To process payroll, generate invoices, and meet tax obligations.</li>
        <li>To dispatch officers, coordinate live operations, and respond to emergencies.</li>
        <li>To investigate incidents and maintain audit records.</li>
        <li>To send service emails (invitations, password resets, onboarding links, schedule alerts).</li>
        <li>To comply with applicable laws and lawful requests from authorities.</li>
      </ul>

      <h2>3. Sharing</h2>
      <p>We do not sell personal information. We share data only with:</p>
      <ul>
        <li>Service providers acting on our behalf (cloud hosting, object storage, SMTP delivery, push-notification gateway, payment processor).</li>
        <li>Clients of {SHORT}, limited to the operational data they need to verify coverage of their sites.</li>
        <li>Government agencies or law enforcement when required by law.</li>
      </ul>

      <h2>4. Retention</h2>
      <p>
        Employment, payroll, and incident records are retained for the period required by Texas and federal law (typically 3–7 years after the employment relationship ends). Operational logs and chat history are retained for up to 24 months unless tied to an active incident.
      </p>

      <h2>5. Security</h2>
      <p>
        We use TLS in transit, password hashing, role-based access controls, signed URLs for private documents, and audit logging on sensitive admin actions. No system is perfectly secure; you must keep your credentials confidential.
      </p>

      <h2>6. Children</h2>
      <p>The platform is not directed to children under 16 and we do not knowingly collect their information.</p>

      <h2>7. Contact</h2>
      <p>
        Questions or requests: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> · {POSTAL}.
      </p>
    </Page>
  );
}

export function TermsPage() {
  return (
    <Page title="Terms of Service" updated="May 2026">
      <p>
        These Terms govern your use of the SecureOps platform operated by {COMPANY}. By using the website, admin portal, or mobile app you agree to these Terms.
      </p>

      <h2>1. Eligibility &amp; accounts</h2>
      <p>
        Access requires a valid {SHORT} account. You must be at least 18 years old and legally permitted to work in the United States (officer accounts) or be an authorised representative of {SHORT} (admin accounts). You are responsible for keeping your credentials secure.
      </p>

      <h2>2. Acceptable use</h2>
      <ul>
        <li>Do not access data outside your role or impersonate another user.</li>
        <li>Do not misuse the emergency button, falsify clock-in/out events, or submit fraudulent incident reports.</li>
        <li>Do not upload unlawful, harassing, or copyright-infringing content.</li>
        <li>Do not probe, scrape, or attempt to circumvent security controls.</li>
      </ul>

      <h2>3. Submitted content</h2>
      <p>
        You retain ownership of documents and information you submit. You grant {SHORT} a non-exclusive licence to store, process, and use that content to operate the platform and meet its legal obligations.
      </p>

      <h2>4. Pay, schedules, and operations</h2>
      <p>
        Schedule postings, claims, time entries, and payroll figures are subject to verification and approval by {SHORT} administrators. Final pay reflects approved hours, applicable deductions, and the terms of your engagement letter.
      </p>

      <h2>5. Service availability</h2>
      <p>
        The platform is provided on an "as is" and "as available" basis. We do not warrant uninterrupted service. We may modify, suspend, or discontinue features with reasonable notice.
      </p>

      <h2>6. Termination</h2>
      <p>
        We may suspend or terminate access for violations of these Terms or where required by law. On termination, your access ends but retention obligations under the Privacy Policy continue.
      </p>

      <h2>7. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, {SHORT} is not liable for indirect, incidental, or consequential damages arising from use of the platform. Nothing in these Terms limits liability that cannot be excluded by law.
      </p>

      <h2>8. Governing law</h2>
      <p>These Terms are governed by the laws of the State of Texas, USA.</p>

      <h2>9. Changes</h2>
      <p>We may update these Terms; material changes will be communicated through the platform or email. Continued use after the effective date constitutes acceptance.</p>

      <h2>10. Contact</h2>
      <p>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> · {POSTAL}.
      </p>
    </Page>
  );
}

export function DataRightsPage() {
  return (
    <Page title="Your Data Rights" updated="May 2026">
      <p>
        Depending on where you live (for example, residents of California, Texas, the EU/UK, and other jurisdictions), you may have rights regarding the personal information {SHORT} holds about you. {SHORT} honours these rights regardless of your location, subject to verification and applicable law.
      </p>

      <h2>Rights you can exercise</h2>
      <ul>
        <li><strong>Access:</strong> request a copy of the personal information we hold about you.</li>
        <li><strong>Correction:</strong> ask us to fix inaccurate or incomplete information.</li>
        <li><strong>Deletion:</strong> ask us to delete information we no longer need to keep. Records we are legally required to retain (e.g. payroll, tax, incident logs) cannot be deleted before their retention period ends.</li>
        <li><strong>Portability:</strong> receive an export of the information you provided in a common machine-readable format.</li>
        <li><strong>Objection / restriction:</strong> ask us to stop or limit certain uses of your data.</li>
        <li><strong>Withdraw consent:</strong> where processing is based on consent (for example, push notifications), withdraw it at any time.</li>
        <li><strong>Complaint:</strong> lodge a complaint with the relevant data-protection authority.</li>
      </ul>

      <h2>How to make a request</h2>
      <p>
        Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> from the address associated with your account, or write to {POSTAL}. Include enough information to verify your identity. We will respond within 30 days (or as required by applicable law) and may need to extend that period for complex requests.
      </p>

      <h2>What we cannot delete</h2>
      <ul>
        <li>Payroll, tax, and wage records retained for 3–7 years per Texas and federal law.</li>
        <li>Audit logs of admin actions and incident records tied to active operational matters.</li>
        <li>Information needed to defend a legal claim or comply with a court order.</li>
      </ul>

      <h2>Mobile permissions</h2>
      <p>
        You can disable push notifications and location sharing in your device settings at any time. Disabling location while clocked in may prevent you from clocking in or out at a site that requires geo-verification.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> · {POSTAL}.
      </p>
    </Page>
  );
}
