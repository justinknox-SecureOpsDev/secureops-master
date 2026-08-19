import type { ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * The agreement signing page lets a customer accept SOBBU's agreements — it
 * does not let them author them. Terms, pricing and SOBBU's own details are
 * provider-set: shown for review, never as inputs, and never posted back.
 *
 * Covered here:
 *   - provider terms render as read-only review rows (no input holds them),
 *   - the acceptance block stays editable,
 *   - signing posts only the acceptance plus the terms digest,
 *   - an unset SOBBU term blocks signing with an explanation instead of
 *     offering the customer a box to fill in.
 *
 * The real page is mounted; only `wouter` and `@/lib/api` are stubbed.
 */

const DIGEST = "a".repeat(64);
/** Present only in the template the mocked server returns, never in the bundle. */
const SERVER_ONLY_CLAUSE = "SERVER-ONLY CLAUSE 99 — added after this bundle shipped.";

const hoisted = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; init?: { method?: string; body?: unknown } }>,
  readyToSign: true,
  missingProviderLabels: [] as string[],
}));

vi.mock("wouter", () => ({
  useRoute: () => [true, { slot: "msa" }],
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    hoisted.calls.push({ path, init });
    if (path.endsWith("/signing-context")) {
      // Built from the real field definitions so the authority split under
      // test is the shipped one, not a hand-written copy.
      const { AGREEMENT_FIELDS, LEGAL_TEMPLATES } = await import("@workspace/legal-docs");
      return {
        slots: {
          msa: {
            title: "Master Services Agreement",
            // Prepended: the MSA filler truncates everything after the
            // Exhibit C guarantor block when no guaranty is executed.
            template: `${SERVER_ONLY_CLAUSE}\n\n${LEGAL_TEMPLATES.msa}`,
            consentText: "I agree to be bound by this agreement.",
            guarantyConsentText: "I personally guarantee the obligations.",
            fields: AGREEMENT_FIELDS.msa.map((def) => ({
              key: def.key,
              label: def.label,
              group: def.group,
              required: def.required,
              authority: def.authority,
              hint: def.hint ?? null,
              multiline: def.multiline ?? false,
              value:
                def.authority !== "provider"
                  ? ""
                  : def.key === "feeAmount"
                    ? "$899.00"
                    : (def.defaultValue ?? `${def.label} — set by SOBBU`),
            })),
            termsDigest: DIGEST,
            readyToSign: hoisted.readyToSign,
            missingProviderLabels: hoisted.missingProviderLabels,
            signed: null,
          },
        },
      };
    }
    return {
      signature: {
        id: "sig-1",
        slot: "msa",
        signerName: "Dana Owner",
        signerTitle: "Owner",
        signerEmail: "dana@example.com",
        signedAt: new Date().toISOString(),
        documentSha256: "0".repeat(64),
        guarantyExecuted: false,
        guarantorName: null,
      },
    };
  }),
  fetchWithAuth: vi.fn(),
}));

import AgreementSign from "../AgreementSign";

beforeEach(() => {
  hoisted.calls.length = 0;
  hoisted.readyToSign = true;
  hoisted.missingProviderLabels = [];
});

describe("AgreementSign — who sets what", () => {
  it("shows SOBBU's terms for review with no way to edit them", async () => {
    render(<AgreementSign />);
    await screen.findByText("$899.00");

    // The fee is displayed, but nothing on the page holds it as an input value.
    expect(screen.queryByDisplayValue("$899.00")).toBeNull();
    // ...and its label is no longer wired to a form control.
    expect(screen.queryByLabelText(/Subscription fee/)).toBeNull();
    expect(screen.queryByLabelText(/Liability cap/)).toBeNull();

    // The acceptance block is still the customer's to complete.
    expect(screen.getByLabelText(/Your full name/)).toBeTruthy();
    expect(screen.getByLabelText(/Your title/)).toBeTruthy();
  });

  it("previews the document the server returned, not this bundle's copy", async () => {
    render(<AgreementSign />);
    // A stale browser build must never show one document and sign another.
    expect(await screen.findByText(/SERVER-ONLY CLAUSE 99/)).toBeTruthy();
  });

  it("posts only the acceptance and the terms digest", async () => {
    render(<AgreementSign />);
    await screen.findByText("$899.00");

    fireEvent.change(screen.getByLabelText(/Your full name/), {
      target: { value: "Dana Owner" },
    });
    fireEvent.change(screen.getByLabelText(/Your title/), { target: { value: "Owner" } });
    fireEvent.change(screen.getByLabelText(/Signature \(type your full name\)/), {
      target: { value: "Dana Owner" },
    });
    fireEvent.click(document.getElementById("agr-consent")!);

    const signButton = screen.getByRole("button", { name: /Sign agreement/ });
    await waitFor(() => expect((signButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(signButton);

    await waitFor(() => {
      expect(hoisted.calls.some((c) => c.init?.method === "POST")).toBe(true);
    });
    const post = hoisted.calls.find((c) => c.init?.method === "POST")!;
    const body = post.init!.body as Record<string, unknown>;

    expect(body["termsDigest"]).toBe(DIGEST);
    expect("fields" in body).toBe(false);
    expect(body["signerName"]).toBe("Dana Owner");
  });

  it("blocks signing, without offering an input, when SOBBU has not set a term", async () => {
    hoisted.readyToSign = false;
    hoisted.missingProviderLabels = ["Subscription fee"];

    render(<AgreementSign />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("SOBBU still has to set");
    expect(alert.textContent).toContain("Subscription fee");
    expect(screen.queryByLabelText(/Subscription fee/)).toBeNull();

    const signButton = screen.getByRole("button", { name: /Sign agreement/ });
    expect((signButton as HTMLButtonElement).disabled).toBe(true);
  });
});
