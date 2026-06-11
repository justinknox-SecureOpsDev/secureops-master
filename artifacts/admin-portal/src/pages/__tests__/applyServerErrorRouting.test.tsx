import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

/**
 * Regression coverage for the *server-side validation recovery* path in the
 * public Apply wizard. When `POST /applications` rejects with an ApiError
 * carrying `fieldErrors`, the wizard must:
 *   - map each error to its wizard step (built-ins via FIELD_TO_STEP,
 *     custom answers via the `custom:<id>` prefix, references via `ref:…`),
 *   - jump the applicant to the *earliest* offending step (not just the first
 *     error in the array), and
 *   - render the offending message inline on that step.
 *
 * This is the applicant's only recovery path when the client and server
 * disagree, so the step-routing (localStepForField + earliest setStep) is
 * exercised end to end here. Only `@/lib/api` is stubbed: the template fetch
 * returns the admin field config, and the `/applications` POST throws a
 * configurable ApiError. `@/lib/upload` pulls `api` from the same mock, so no
 * real network is touched.
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

type TemplateQuestion = {
  id: string;
  label: string;
  helpText: string | null;
  fieldType: string;
  required: boolean;
  options: string[] | null;
  sortOrder: number;
  enabled: boolean;
};

type SubmitError = { status: number; message: string; data: unknown } | null;

const hoisted = vi.hoisted(() => ({
  fieldConfig: [] as EffectiveField[],
  questions: [] as TemplateQuestion[],
  submitError: null as SubmitError,
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
        return { questions: hoisted.questions, fieldConfig: hoisted.fieldConfig };
      }
      if (path === "/applications" && init?.method === "POST") {
        if (hoisted.submitError) {
          throw new ApiError(
            hoisted.submitError.status,
            hoisted.submitError.message,
            hoisted.submitError.data,
          );
        }
        return {};
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

// The five locked core fields are always visible + required + sent. We add
// "city" as a visible-but-optional field, and omit every other built-in so it
// is treated as hidden — keeping step 0 the only built-in step with inputs and
// letting client-side validation pass straight through to the POST.
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

const VEHICLE_QUESTION: TemplateQuestion = {
  id: "q-vehicle",
  label: "Do you have a reliable vehicle?",
  helpText: null,
  fieldType: "yes_no",
  required: false,
  options: null,
  sortOrder: 0,
  enabled: true,
};

function fillCoreFields() {
  fireEvent.change(screen.getByLabelText(/First name/i), { target: { value: "Jane" } });
  fireEvent.change(screen.getByLabelText(/Last name/i), { target: { value: "Doe" } });
  fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: "jane@example.com" } });
  fireEvent.change(screen.getByLabelText(/Phone/i), { target: { value: "2145551234" } });
  fireEvent.change(screen.getByLabelText(/Street address/i), { target: { value: "1 Main St" } });
}

function clickContinue() {
  fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
}

async function walkToReviewAndSubmit() {
  fillCoreFields();
  // With a custom question the wizard has 7 steps (0..6); Review is index 6, so
  // six Continues take us from Personal (0) to Review.
  for (let i = 0; i < 6; i++) clickContinue();
  fireEvent.click(screen.getByRole("button", { name: /Submit application/i }));
}

beforeEach(() => {
  hoisted.fieldConfig = baseConfig();
  hoisted.questions = [VEHICLE_QUESTION];
  hoisted.submitError = null;
});

describe("Apply wizard — server-side validation routing", () => {
  it("jumps to the earliest offending step and shows its inline error", async () => {
    // Server rejects fields on steps 2 (TX license), 5 (custom) and 0 (phone).
    // The step-0 error is *last* in the array to prove the wizard navigates to
    // the minimum offending step, not merely the first error returned.
    hoisted.submitError = {
      status: 422,
      message: "Validation failed",
      data: {
        fieldErrors: [
          { field: "siaLicenseNumber", message: "License number is invalid." },
          { field: "custom:q-vehicle", message: "Please answer the vehicle question." },
          { field: "phone", message: "That phone number is already registered." },
        ],
      },
    };

    render(<ApplyPage />);
    await waitFor(() => expect(screen.getByLabelText(/City/i)).toBeTruthy());
    // Custom question is in the template, so the wizard has 7 steps.
    await waitFor(() => expect(screen.getByText(/Additional questions/i)).toBeTruthy());

    await walkToReviewAndSubmit();

    // The wizard lands on step 0 (earliest offending), not step 2 or 5.
    await waitFor(() => expect(screen.getByText(/Personal details/i)).toBeTruthy());
    expect(screen.getByText(/Step 1 of 7/i)).toBeTruthy();
    // The Review summary list is gone because we left the Review step.
    expect(screen.queryByText(/Please fix the following before submitting/i)).toBeNull();

    // The phone error renders inline on step 0.
    expect(screen.getByText(/That phone number is already registered\./i)).toBeTruthy();
    // The custom-step error is not visible here (it lives on the custom step).
    expect(screen.queryByText(/Please answer the vehicle question\./i)).toBeNull();
  });

  it("routes a custom-question error to the Additional questions step", async () => {
    hoisted.submitError = {
      status: 422,
      message: "Validation failed",
      data: {
        fieldErrors: [
          { field: "custom:q-vehicle", message: "Please answer the vehicle question." },
        ],
      },
    };

    render(<ApplyPage />);
    await waitFor(() => expect(screen.getByLabelText(/City/i)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/Additional questions/i)).toBeTruthy());

    await walkToReviewAndSubmit();

    // Earliest (and only) offending step is the custom step (index 5).
    await waitFor(() => expect(screen.getByText(/Step 6 of 7/i)).toBeTruthy());
    // The custom question + its error render on that step.
    expect(screen.getByText(/Do you have a reliable vehicle\?/i)).toBeTruthy();
    expect(screen.getByText(/Please answer the vehicle question\./i)).toBeTruthy();
  });

  it("falls back to a general error banner when the server sends no fieldErrors", async () => {
    hoisted.submitError = {
      status: 500,
      message: "Something went wrong on our end.",
      data: { message: "Something went wrong on our end." },
    };

    render(<ApplyPage />);
    await waitFor(() => expect(screen.getByLabelText(/City/i)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/Additional questions/i)).toBeTruthy());

    await walkToReviewAndSubmit();

    // No fieldErrors -> stay on Review and surface the general message.
    await waitFor(() => expect(screen.getByText(/Something went wrong on our end\./i)).toBeTruthy());
    expect(screen.getByText(/Review &/i)).toBeTruthy();
  });
});
