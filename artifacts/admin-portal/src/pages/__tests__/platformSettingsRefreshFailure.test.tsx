/**
 * Platform settings (branding · customer account · feature flags) must never
 * hide a save that failed — or disguise a failed read as "nothing is stored".
 *
 * Same defect class as the Legal & Agreements upload report: each card drew
 * "request failed", "still loading" and "nothing configured" identically, so a
 * successful save whose confirming refresh failed silently reverted to the
 * built-in defaults, and an unreachable API looked exactly like an empty
 * setting.
 *
 * These tests pin the reporting contract from
 * `.agents/memory/unknown-vs-empty-ui-state.md`:
 *   - the server's write reply is authoritative even when the refresh fails;
 *   - a failed read is labelled with a retry, never drawn as the default;
 *   - the outcome is reported next to the control that produced it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));
vi.mock("@/lib/brand", () => ({ refreshBrand: vi.fn(async () => undefined) }));

import { api } from "@/lib/api";
import PlatformFeaturesPage from "@/pages/PlatformFeatures";

const apiMock = vi.mocked(api);

type Init = { method?: string; body?: unknown } | undefined;

const BRAND_STORED = {
  companyName: "Old Co",
  shortName: null,
  tagline: null,
  companyLicense: null,
  appName: null,
  colorNavy: null,
  colorGold: null,
  colorCream: null,
  billingEmail: null,
  hrEmail: null,
  adminNotifyEmail: null,
  backgroundCheckAdminUserId: null,
  logoDataUrl: null,
};

const CONFIG_STORED = {
  customerName: "Acme Security",
  planTier: "professional",
  monthlyPriceCents: 89900,
  officerCount: 40,
  billingNotes: null,
  planStartDate: null,
  timeConfirmEditWindowHours: null,
  autoClockOutDelayMinutes: null,
};

const FEATURES_STORED = [
  { key: "chat", enabled: true, source: "env", envDisabled: false },
  { key: "radio", enabled: false, source: "env", envDisabled: true },
];

/**
 * Wires every request the page makes. Each settings GET is served by a
 * supplier so a test can make the *second* read (the post-save confirmation)
 * fail while the first succeeds.
 */
function mockPage(opts: {
  brand?: () => Promise<unknown>;
  config?: () => Promise<unknown>;
  features?: () => Promise<unknown>;
  onWrite?: (path: string, body: unknown) => Promise<unknown>;
}) {
  apiMock.mockImplementation((async (path: string, init: Init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      if (!opts.onWrite) throw new Error(`unexpected ${method} ${path}`);
      return opts.onWrite(path, init?.body);
    }
    if (path === "/admin/platform/me") return { isSuperAdmin: true };
    if (path.startsWith("/admin/tables/users")) return { rows: [] };
    if (path === "/admin/platform/brand")
      return opts.brand ? opts.brand() : { config: BRAND_STORED };
    if (path === "/admin/platform/customer-config")
      return opts.config ? opts.config() : { config: CONFIG_STORED };
    if (path === "/admin/platform/features")
      return opts.features ? opts.features() : { features: FEATURES_STORED };
    throw new Error(`unexpected GET ${path}`);
  }) as unknown as typeof api);
}

/** Supplier that answers once from `first`, then fails every later read. */
function thenFails(first: unknown) {
  let served = false;
  return async () => {
    if (served) throw new Error("Failed to fetch");
    served = true;
    return first;
  };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PlatformFeaturesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Branding settings", () => {
  it("keeps the saved values when the confirming refresh fails", async () => {
    mockPage({
      brand: thenFails({ config: BRAND_STORED }),
      onWrite: async (path, body) => {
        expect(path).toBe("/admin/platform/brand");
        return { config: { ...BRAND_STORED, ...(body as object) } };
      },
    });
    renderPage();

    const name = (await screen.findByPlaceholderText(
      "Williams Council Security Group",
    )) as HTMLInputElement;
    expect(name.value).toBe("Old Co");

    fireEvent.change(name, { target: { value: "New Co" } });
    fireEvent.click(screen.getByRole("button", { name: /save branding/i }));

    // The write reply is authoritative: the failed re-read must not put the
    // card back to the pre-save value (or to a blank "not configured" field).
    const saved = await screen.findByText(/Saved — the branding is stored/i);
    expect(saved).toBeTruthy();
    expect(
      (screen.getByPlaceholderText("Williams Council Security Group") as HTMLInputElement).value,
    ).toBe("New Co");
  });

  it("labels an unreadable brand read instead of showing the blank defaults", async () => {
    mockPage({
      brand: async () => {
        throw new Error("Failed to fetch");
      },
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load the branding settings/i)).toBeTruthy(),
    );
    // The editable fields (which would read as "nothing configured") are gone,
    // replaced by the failure plus a retry.
    expect(screen.queryByPlaceholderText("Williams Council Security Group")).toBeNull();
    expect(screen.getAllByRole("button", { name: /try again/i }).length).toBeGreaterThan(0);
  });

  it("says nothing was stored when the server refuses the write (4xx)", async () => {
    const { ApiError } = await import("@/lib/api");
    mockPage({
      onWrite: async () => {
        throw new ApiError(400, "Colour must be a hex value.");
      },
    });
    renderPage();

    const name = (await screen.findByPlaceholderText(
      "Williams Council Security Group",
    )) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "New Co" } });
    fireEvent.click(screen.getByRole("button", { name: /save branding/i }));

    expect(await screen.findByText(/Not saved — Colour must be a hex value\./i)).toBeTruthy();
  });
});

describe("Customer account settings", () => {
  it("keeps the saved values when the confirming refresh fails", async () => {
    mockPage({
      config: thenFails({ config: CONFIG_STORED }),
      onWrite: async (path, body) => {
        expect(path).toBe("/admin/platform/customer-config");
        return { config: { ...CONFIG_STORED, ...(body as object) } };
      },
    });
    renderPage();

    const officers = (await screen.findByPlaceholderText("e.g. 47")) as HTMLInputElement;
    expect(officers.value).toBe("40");

    fireEvent.change(officers, { target: { value: "55" } });
    fireEvent.click(screen.getByRole("button", { name: /save account details/i }));

    expect(await screen.findByText(/Saved — the details are stored/i)).toBeTruthy();
    expect((screen.getByPlaceholderText("e.g. 47") as HTMLInputElement).value).toBe("55");
  });

  it("labels an unreadable customer-account read instead of showing empty fields", async () => {
    mockPage({
      config: async () => {
        throw new Error("Failed to fetch");
      },
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load the customer account settings/i)).toBeTruthy(),
    );
    expect(screen.queryByPlaceholderText("e.g. 47")).toBeNull();
  });
});

describe("Feature flag settings", () => {
  it("keeps the saved toggles when the confirming refresh fails", async () => {
    mockPage({
      features: thenFails({ features: FEATURES_STORED }),
      onWrite: async (path) => {
        expect(path).toBe("/admin/platform/features");
        return {
          features: [
            { key: "chat", enabled: false, source: "override", envDisabled: false },
            FEATURES_STORED[1],
          ],
        };
      },
    });
    renderPage();

    const chatToggle = await waitFor(() => {
      const el = screen.getByText("Team chat").closest("div.flex")?.parentElement;
      const toggle = el?.querySelector("button[aria-pressed]") as HTMLButtonElement | null;
      if (!toggle) throw new Error("toggle not rendered yet");
      return toggle;
    });
    expect(chatToggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(chatToggle);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText(/Saved — the flags are stored/i)).toBeTruthy();
    // The failed re-read must not restore the pre-save "on via env" state.
    await waitFor(() => {
      const toggle = screen
        .getByText("Team chat")
        .closest("div.flex")
        ?.parentElement?.querySelector("button[aria-pressed]") as HTMLButtonElement;
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
    });
  });

  it("labels an unreadable feature read instead of rendering an empty list", async () => {
    mockPage({
      features: async () => {
        throw new Error("Failed to fetch");
      },
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load the feature flag settings/i)).toBeTruthy(),
    );
  });
});
