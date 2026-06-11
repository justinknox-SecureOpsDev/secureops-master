import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

/**
 * Regression coverage for the *save* half of "Save & finish later" in the
 * public Apply wizard. Clicking the button calls saveDraft(), which:
 *   - POSTs { email, step, data } (plus an optional resume token) to
 *     `/applications/draft`, carrying the applicant's current wizard step and
 *     every answer entered so far, and
 *   - renders a SaveState banner: the success banner names the email address
 *     when the server reports `emailSent: true`, a fallback banner when
 *     `emailSent: false`, and an error banner when the POST itself fails.
 *
 * This is the entry point to the whole resume flow (the *restore* half is
 * covered elsewhere), so a regression here would silently break it. Only
 * `@/lib/api` is stubbed: the template fetch returns the admin field config,
 * and the `/applications/draft` POST records the body it received and returns
 * a configurable result (or throws a configurable ApiError). No real network
 * is touched.
 */

type EffectiveField = {
  key: string;
  section: number;
  label: string;
  helpText: string | null;
  required: boolean;
  hidden: boolean;
  sortOrder: number;
  locked: boolean;
};

type DraftBody = { email?: string; step?: number; data?: Record<string, unknown>; token?: string };
type DraftError = { status: number; message: string } | null;

const hoisted = vi.hoisted(() => ({
  fieldConfig: [] as EffectiveField[],
  draftEmailSent: true,
  draftError: null as DraftError,
  lastDraftBody: null as DraftBody | null,
}));

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    status: number;
    data: unknown;
    constructor(status = 500, message = "api error", data?: unknown) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }
  return {
    ApiError,
    api: vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
      if (path === "/application-template") {
        return { questions: [], fieldConfig: hoisted.fieldConfig };
      }
      if (path === "/applications/draft" && init?.method === "POST") {
        hoisted.lastDraftBody = (init.body ?? null) as DraftBody | null;
        if (hoisted.draftError) {
          throw new ApiError(hoisted.draftError.status, hoisted.draftError.message);
        }
        return { ok: true, emailSent: hoisted.draftEmailSent, expiresAt: "2099-01-01T00:00:00.000Z" };
      }
      return {};
    }),
  };
});

import { ApplyPage } from "@/pages/Apply";

function field(
  partial: Partial<EffectiveField> & Pick<EffectiveField, "key" | "label">,
): EffectiveField {
  return {
    section: 0,
    helpText: null,
    required: true,
    hidden: false,
    sortOrder: 0,
    locked: false,
    ...partial,
  };
}

// The five locked core fields plus an optional "city". Every other built-in is
// omitted (treated as hidden), keeping step 0 the only built-in step with
// inputs so client-side validation passes when we advance.
function baseConfig(): EffectiveField[] {
  return [
    field({ key: "firstName", label: "First name", locked: true, sortOrder: 0 }),
    field({ key: "lastName", label: "Last name", locked: true, sortOrder: 1 }),
    field({ key: "email", label: "Email", locked: true, sortOrder: 2 }),
    field({ key: "phone", label: "Phone", locked: true, sortOrder: 3 }),
    field({ key: "address", label: "Street address", locked: true, sortOrder: 4 }),
    field({ key: "city", label: "City", required: false, sortOrder: 5 }),
  ];
}

function fillCoreFields() {
  fireEvent.change(screen.getByLabelText(/First name/i), { target: { value: "Jane" } });
  fireEvent.change(screen.getByLabelText(/Last name/i), { target: { value: "Doe" } });
  fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: "jane@example.com" } });
  fireEvent.change(screen.getByLabelText(/Phone/i), { target: { value: "2145551234" } });
  fireEvent.change(screen.getByLabelText(/Street address/i), { target: { value: "1 Main St" } });
}

function clickSaveForLater() {
  fireEvent.click(screen.getByRole("button", { name: /Save & finish later/i }));
}

beforeEach(() => {
  hoisted.fieldConfig = baseConfig();
  hoisted.draftEmailSent = true;
  hoisted.draftError = null;
  hoisted.lastDraftBody = null;
});

describe("Apply wizard — Save & finish later", () => {
  it("posts the current step + answers and shows the success banner with the email", async () => {
    render(<ApplyPage />);
    await waitFor(() => expect(screen.getByLabelText(/City/i)).toBeTruthy());

    fillCoreFields();
    // Advance to step 1 (I-9 & Identity) so the draft body proves it carries the
    // applicant's *current* step, not just step 0.
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    await waitFor(() => expect(screen.getByText(/Step 2 of 6/i)).toBeTruthy());

    clickSaveForLater();

    await waitFor(() => expect(hoisted.lastDraftBody).not.toBeNull());
    const body = hoisted.lastDraftBody!;
    expect(body.email).toBe("jane@example.com");
    expect(body.step).toBe(1);
    expect(body.data).toBeTruthy();
    expect(body.data!.firstName).toBe("Jane");
    expect(body.data!.lastName).toBe("Doe");
    expect(body.data!.email).toBe("jane@example.com");
    expect(body.data!.address).toBe("1 Main St");
    // No resume token on a first-time save.
    expect(body.token).toBeUndefined();

    // Success banner names the email address.
    await waitFor(() =>
      expect(screen.getByText(/We just emailed a resume link to/i)).toBeTruthy(),
    );
    expect(screen.getByText("jane@example.com")).toBeTruthy();
  });

  it("shows the fallback banner when the server reports emailSent: false", async () => {
    hoisted.draftEmailSent = false;

    render(<ApplyPage />);
    await waitFor(() => expect(screen.getByLabelText(/City/i)).toBeTruthy());

    fillCoreFields();
    clickSaveForLater();

    await waitFor(() =>
      expect(screen.getByText(/we weren't able to email you a resume link/i)).toBeTruthy(),
    );
    // The success ("we just emailed…") wording must not appear in the fallback.
    expect(screen.queryByText(/We just emailed a resume link to/i)).toBeNull();
  });

  it("surfaces the error banner when the save fails", async () => {
    hoisted.draftError = { status: 500, message: "We couldn't save your application right now." };

    render(<ApplyPage />);
    await waitFor(() => expect(screen.getByLabelText(/City/i)).toBeTruthy());

    fillCoreFields();
    clickSaveForLater();

    await waitFor(() =>
      expect(screen.getByText(/We couldn't save your application right now\./i)).toBeTruthy(),
    );
    // A failed save must not render either success/fallback banner.
    expect(screen.queryByText(/Your progress is saved/i)).toBeNull();
  });
});
