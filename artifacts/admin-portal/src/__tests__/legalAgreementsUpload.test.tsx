/**
 * Legal & Agreements — the upload/replace flow must never lie about what is
 * stored.
 *
 * Reported symptom: "I uploaded a replacement agreement and the card still
 * says Template." The page previously rendered three different situations
 * identically (bundled template / status request failed / status not yet
 * loaded), so a *successful* upload whose follow-up refresh failed silently
 * reverted to the template look, and a server that was simply unreachable
 * looked exactly like "nothing was ever uploaded".
 *
 * These tests pin the reporting contract:
 *   - the server's write reply is authoritative even if the refresh fails;
 *   - a failed status read is labelled, never disguised as "Template";
 *   - a failed upload says so on the card that failed (not only page-top,
 *     which is off-screen on a phone where the cards stack).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// Keep the real ApiError: the page distinguishes a server rejection (nothing
// was written) from a transport failure (outcome unknown) by its type.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));
vi.mock("@/lib/upload", () => ({ uploadFile: vi.fn() }));
vi.mock("@/pages/AgreementSign", () => ({ downloadSignedPdf: vi.fn() }));

import { api, ApiError } from "@/lib/api";
import { uploadFile } from "@/lib/upload";
import LegalAgreementsPage from "@/pages/LegalAgreements";

const apiMock = vi.mocked(api);
const uploadFileMock = vi.mocked(uploadFile);

type ApiInit = { method?: string } | undefined;

const NO_DOCS = {
  agreements: [
    { slot: "msa", custom: null },
    { slot: "user_agreement", custom: null },
  ],
};

const UPLOADED_MSA = {
  slot: "msa",
  custom: {
    fileName: "MSA-executed.pdf",
    fileSize: 1024,
    uploadedAt: new Date().toISOString(),
    uploadedBy: "owner@example.test",
  },
};

/** Wires the three GETs the page issues on mount; `onStatus` supplies the list. */
function mockPage(opts: {
  status: () => Promise<unknown>;
  onPut?: (slot: string) => Promise<unknown>;
}) {
  apiMock.mockImplementation((async (path: string, init: ApiInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/admin/platform/me") return { isSuperAdmin: true };
    if (path === "/admin/platform/agreements/signatures")
      return { signatures: { msa: null, user_agreement: null } };
    if (path === "/admin/platform/agreements" && method === "GET") return opts.status();
    if (method === "PUT" && path.startsWith("/admin/platform/agreements/")) {
      const slot = path.split("/").pop() as string;
      if (opts.onPut) return opts.onPut(slot);
      return UPLOADED_MSA;
    }
    throw new Error(`unexpected call ${method} ${path}`);
  }) as unknown as typeof api);
}

function pickPdf(index = 0, name = "MSA-executed.pdf") {
  const input = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[index]!;
  const file = new File(["%PDF-1.4 fake"], name, { type: "application/pdf" });
  // jsdom's `files` is read-only, so fireEvent's `target` shorthand can't set it.
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

/** The card for the Master Subscription Agreement (shadcn Card root). */
function msaCard(): HTMLElement {
  return screen.getByText("Master Subscription Agreement").closest("div.rounded-xl") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  uploadFileMock.mockResolvedValue({
    objectPath: "/objects/uploads/u/owner/abc",
    name: "MSA-executed.pdf",
  } as Awaited<ReturnType<typeof uploadFile>>);
});

describe("Legal & Agreements upload/replace reporting", () => {
  it("keeps the uploaded state when the post-upload refresh fails", async () => {
    let statusCalls = 0;
    mockPage({
      status: async () => {
        statusCalls += 1;
        // First load succeeds (both slots on the bundled template); the refresh
        // that follows the upload fails, as it would against a restarting API.
        if (statusCalls === 1) return NO_DOCS;
        throw new Error("Failed to fetch");
      },
    });

    render(<LegalAgreementsPage />);
    expect(await within(msaCard()).findByText("Template")).toBeTruthy();

    pickPdf();

    // The write reply is authoritative: the badge flips even though the
    // refresh failed, and the card says the document is stored.
    expect(await within(msaCard()).findByText("Uploaded document")).toBeTruthy();
    expect(within(msaCard()).queryByText("Template")).toBeNull();
    const note = await within(msaCard()).findByRole("status");
    expect(note.textContent).toContain("MSA-executed.pdf");
    expect(note.textContent).toMatch(/stored/i);
  });

  it("shows the replacement immediately when everything succeeds", async () => {
    let statusCalls = 0;
    mockPage({
      status: async () => {
        statusCalls += 1;
        return statusCalls === 1 ? NO_DOCS : { agreements: [UPLOADED_MSA, { slot: "user_agreement", custom: null }] };
      },
    });

    render(<LegalAgreementsPage />);
    expect(await within(msaCard()).findByText("Template")).toBeTruthy();

    pickPdf();

    expect(await within(msaCard()).findByText("Uploaded document")).toBeTruthy();
    const note = await within(msaCard()).findByRole("status");
    expect(note.textContent).toMatch(/is now the active document/i);
    // The second card is untouched by the first card's upload.
    expect(within(msaCard()).queryByText("Template")).toBeNull();
  });

  it("reports a server-rejected upload on the card and does not claim success", async () => {
    mockPage({
      status: async () => NO_DOCS,
      onPut: async () => {
        throw new ApiError(403, "Super-admin access required.");
      },
    });

    render(<LegalAgreementsPage />);
    expect(await within(msaCard()).findByText("Template")).toBeTruthy();

    pickPdf();

    const alert = await within(msaCard()).findByRole("alert");
    expect(alert.textContent).toContain("Super-admin access required.");
    expect(alert.textContent).toMatch(/not replaced/i);
    expect(within(msaCard()).getByText("Template")).toBeTruthy();
    expect(within(msaCard()).queryByText("Uploaded document")).toBeNull();
  });

  it("never claims failure when the write's outcome is unknown", async () => {
    // A dropped connection (no HTTP status) after the server may already have
    // committed. Saying "not replaced" would be a guess — the card must show
    // what is actually stored instead.
    let statusCalls = 0;
    mockPage({
      status: async () => {
        statusCalls += 1;
        return statusCalls === 1
          ? NO_DOCS
          : { agreements: [UPLOADED_MSA, { slot: "user_agreement", custom: null }] };
      },
      onPut: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    render(<LegalAgreementsPage />);
    expect(await within(msaCard()).findByText("Template")).toBeTruthy();

    pickPdf();

    const alert = await within(msaCard()).findByRole("alert");
    expect(alert.textContent).toMatch(/couldn.t confirm/i);
    expect(alert.textContent).not.toMatch(/not replaced/i);
    // The write did land server-side, so the refreshed state must be shown.
    expect(await within(msaCard()).findByText("Uploaded document")).toBeTruthy();
  });

  it("treats a 5xx as unconfirmed rather than a refusal", async () => {
    // A gateway/restart 5xx can arrive after the route already committed, so
    // it cannot be reported as "not replaced" the way a 4xx refusal can.
    mockPage({
      status: async () => NO_DOCS,
      onPut: async () => {
        throw new ApiError(503, "Service Unavailable");
      },
    });

    render(<LegalAgreementsPage />);
    expect(await within(msaCard()).findByText("Template")).toBeTruthy();

    pickPdf();

    const alert = await within(msaCard()).findByRole("alert");
    expect(alert.textContent).toMatch(/couldn.t confirm/i);
    expect(alert.textContent).not.toMatch(/not replaced/i);
  });

  it("ignores a stale status response racing an unconfirmed write's check", async () => {
    let releaseFirst!: (v: unknown) => void;
    const firstStatus = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let statusCalls = 0;
    mockPage({
      status: async () => {
        statusCalls += 1;
        return statusCalls === 1
          ? firstStatus
          : { agreements: [UPLOADED_MSA, { slot: "user_agreement", custom: null }] };
      },
      onPut: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    render(<LegalAgreementsPage />);
    await waitFor(() =>
      expect(document.querySelectorAll('input[type="file"]').length).toBe(2),
    );

    pickPdf();
    // The verification read proves the write did land.
    expect(await within(msaCard()).findByText("Uploaded document")).toBeTruthy();

    releaseFirst(NO_DOCS);
    await new Promise((r) => setTimeout(r, 0));

    expect(within(msaCard()).getByText("Uploaded document")).toBeTruthy();
    expect(within(msaCard()).queryByText("Template")).toBeNull();
  });

  it("ignores a stale status response that resolves after a confirmed write", async () => {
    // The mount request can still be in flight when the upload completes;
    // committing its older "no document" answer would silently undo the badge.
    let releaseFirst!: (v: unknown) => void;
    const firstStatus = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let statusCalls = 0;
    mockPage({
      status: async () => {
        statusCalls += 1;
        return statusCalls === 1
          ? firstStatus
          : { agreements: [UPLOADED_MSA, { slot: "user_agreement", custom: null }] };
      },
    });

    render(<LegalAgreementsPage />);
    await waitFor(() =>
      expect(document.querySelectorAll('input[type="file"]').length).toBe(2),
    );

    pickPdf();
    expect(await within(msaCard()).findByText("Uploaded document")).toBeTruthy();

    // The mount read now answers, with pre-upload data.
    releaseFirst(NO_DOCS);
    await new Promise((r) => setTimeout(r, 0));

    expect(within(msaCard()).getByText("Uploaded document")).toBeTruthy();
    expect(within(msaCard()).queryByText("Template")).toBeNull();
  });

  it("rejects a non-PDF choice without calling the server", async () => {
    mockPage({ status: async () => NO_DOCS });

    render(<LegalAgreementsPage />);
    await within(msaCard()).findByText("Template");

    pickPdf(0, "agreement.docx");

    const alert = await within(msaCard()).findByRole("alert");
    expect(alert.textContent).toMatch(/PDF/i);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("labels an unreadable status instead of showing it as a template", async () => {
    mockPage({
      status: async () => {
        throw new Error("Failed to fetch");
      },
    });

    render(<LegalAgreementsPage />);

    expect(await screen.findAllByText("Status unavailable")).toHaveLength(2);
    expect(screen.queryByText("Template")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/couldn.t check/i),
    );
  });
});
