import type { ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * When the platform owner replaces a slot's bundled template with an uploaded
 * PDF, that PDF is the agreement. The review & sign page must therefore show
 * the uploaded file itself — never the bundled markdown wording, and never a
 * fill-in-the-terms form for a document whose wording is already fixed.
 */

const DIGEST = "c".repeat(64);
const DOC_SHA = "d".repeat(64);
/** Text unique to the bundled template — it must not appear for an uploaded doc. */
const TEMPLATE_MARKER = "Master Subscription Agreement";

const hoisted = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; init?: { method?: string; body?: unknown } }>,
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
      return {
        slots: {
          msa: {
            title: "Master Subscription Agreement",
            source: "uploaded",
            template: null,
            document: {
              fileName: "Executed-MSA.pdf",
              fileSize: 4242,
              documentSha256: DOC_SHA,
              uploadedAt: new Date().toISOString(),
            },
            unavailableReason: null,
            consentText: "I agree to be bound by this agreement.",
            guarantyConsentText: null,
            fields: [],
            termsDigest: DIGEST,
            readyToSign: true,
            missingProviderLabels: [],
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
        documentSha256: DOC_SHA,
        documentSource: "uploaded",
        guarantyExecuted: false,
        guarantorName: null,
      },
    };
  }),
  // The document is streamed same-origin from the API, not from storage.
  fetchWithAuth: vi.fn(async (path: string) => {
    hoisted.calls.push({ path });
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob(["%PDF-1.7"], { type: "application/pdf" }),
    } as unknown as Response;
  }),
}));

import AgreementSign from "../AgreementSign";

const realCreateObjectURL = globalThis.URL.createObjectURL;
const realRevokeObjectURL = globalThis.URL.revokeObjectURL;

beforeEach(() => {
  hoisted.calls.length = 0;
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mock-agreement");
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  globalThis.URL.createObjectURL = realCreateObjectURL;
  globalThis.URL.revokeObjectURL = realRevokeObjectURL;
});

describe("AgreementSign — uploaded document", () => {
  it("shows the uploaded PDF as the document, not the bundled wording", async () => {
    render(<AgreementSign />);

    const frame = await screen.findByTitle(/document being signed/i);
    expect(frame.getAttribute("src")).toBe("blob:mock-agreement");
    expect(screen.getByText(/Executed-MSA\.pdf/)).toBeTruthy();
    expect(screen.getByText(DOC_SHA)).toBeTruthy();
    // The bundled template's clauses must not be presented as the agreement.
    expect(screen.queryByText(new RegExp(`${TEMPLATE_MARKER} between`))).toBeNull();
    expect(screen.queryByLabelText(/Subscription fee/)).toBeNull();
    // A fixed PDF has no bundled Exhibit C to execute.
    expect(screen.queryByLabelText(/Personal Guaranty/i)).toBeNull();
  });

  it("won't let the document be signed before it has been displayed", async () => {
    render(<AgreementSign />);
    await screen.findByTitle(/document being signed/i);

    fireEvent.change(screen.getByLabelText(/Your full name/), { target: { value: "Dana Owner" } });
    fireEvent.change(screen.getByLabelText(/Your title/), { target: { value: "Owner" } });
    fireEvent.change(screen.getByLabelText(/Signature \(type your full name\)/), {
      target: { value: "Dana Owner" },
    });
    fireEvent.click(document.getElementById("agr-consent")!);

    // Acceptance is complete, but the PDF hasn't rendered yet.
    const signButton = screen.getByRole("button", { name: /Sign agreement/ });
    expect((signButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.load(screen.getByTitle(/document being signed/i));
    await waitFor(() => expect((signButton as HTMLButtonElement).disabled).toBe(false));
  });

  it("signs against the uploaded document's digest", async () => {
    render(<AgreementSign />);
    fireEvent.load(await screen.findByTitle(/document being signed/i));

    fireEvent.change(screen.getByLabelText(/Your full name/), { target: { value: "Dana Owner" } });
    fireEvent.change(screen.getByLabelText(/Your title/), { target: { value: "Owner" } });
    fireEvent.change(screen.getByLabelText(/Signature \(type your full name\)/), {
      target: { value: "Dana Owner" },
    });
    fireEvent.click(document.getElementById("agr-consent")!);

    const signButton = screen.getByRole("button", { name: /Sign agreement/ });
    await waitFor(() => expect((signButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(signButton);

    await waitFor(() => expect(hoisted.calls.some((c) => c.init?.method === "POST")).toBe(true));
    const body = hoisted.calls.find((c) => c.init?.method === "POST")!.init!.body as Record<
      string,
      unknown
    >;
    expect(body["termsDigest"]).toBe(DIGEST);
    expect("guarantor" in body).toBe(false);
  });
});
