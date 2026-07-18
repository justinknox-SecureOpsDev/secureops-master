/**
 * Invite-email rendering tests.
 *
 * A staff invitation email should let a new hire connect the SecureOps mobile
 * app straight from their inbox: it carries the org-connect link
 * (`<origin>/connect?code=<code>`), the org code as a typeable fallback, and an
 * inline QR image (referenced by `cid:`) when one is attached. When the org code
 * can't be resolved, the email must degrade gracefully — no connect link, no QR,
 * just the existing "open the app" fallback.
 */

import { describe, expect, it } from "vitest";
import { renderInviteEmail } from "../lib/email";

describe("renderInviteEmail", () => {
  const baseOpts = {
    firstName: "Jordan",
    email: "jordan@example.com",
    tempPassword: "Abc23xyzPq",
  };

  it("includes the connect link, org code, and inline QR when provided", () => {
    const msg = renderInviteEmail({
      ...baseOpts,
      appUrl: "https://app.example.com/",
      connectUrl: "https://app.example.com/connect?code=acme",
      orgCode: "acme",
      qrCid: "org-invite-qr",
    });

    // Plain-text body carries the connect link + typeable code fallback.
    expect(msg.text).toContain("https://app.example.com/connect?code=acme");
    expect(msg.text).toContain('organization code "acme"');

    // HTML body has the connect CTA and references the inline QR by cid.
    expect(msg.html).toContain('href="https://app.example.com/connect?code=acme"');
    expect(msg.html).toContain('src="cid:org-invite-qr"');
    expect(msg.html).toContain("acme");
  });

  it("renders the connect link without a QR when no qrCid is given", () => {
    const msg = renderInviteEmail({
      ...baseOpts,
      connectUrl: "https://app.example.com/connect?code=acme",
      orgCode: "acme",
      qrCid: null,
    });
    expect(msg.html).toContain('href="https://app.example.com/connect?code=acme"');
    expect(msg.html).not.toContain("cid:");
  });

  it("falls back gracefully to the app link when the org code can't be resolved", () => {
    const msg = renderInviteEmail({
      ...baseOpts,
      appUrl: "https://app.example.com/",
      connectUrl: null,
      orgCode: null,
      qrCid: null,
    });
    expect(msg.text).toContain("Open the SecureOps app: https://app.example.com/");
    expect(msg.text).not.toContain("connect?code=");
    expect(msg.html).toContain('href="https://app.example.com/"');
    expect(msg.html).not.toContain("connect?code=");
    expect(msg.html).not.toContain("cid:");
  });

  it("always carries the sign-in credentials", () => {
    const msg = renderInviteEmail({ ...baseOpts, connectUrl: null });
    expect(msg.text).toContain("jordan@example.com");
    expect(msg.text).toContain("Abc23xyzPq");
    expect(msg.html).toContain("jordan@example.com");
    expect(msg.html).toContain("Abc23xyzPq");
  });
});
