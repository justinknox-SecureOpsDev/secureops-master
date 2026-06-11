import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

/**
 * Regression coverage for the *applicant-facing* side of the configurable
 * application contract. The public Apply wizard fetches `/application-template`
 * and must honour the admin's per-field config it gets back:
 *   - hidden built-ins must not render at all,
 *   - admin-optional built-ins must not block "Continue"/"Submit" when blank,
 *   - the submitted payload must OMIT blank optional built-ins (never send
 *     ""/0/null — see the configurable-form-optional-payload memory note),
 *   - admin-defined custom questions must appear on their own step.
 *
 * Only `@/lib/api` is stubbed (template fetch + submit capture); the real
 * Apply page is mounted so the effective-field plumbing, step validation,
 * and payload assembly are exercised end to end. `@/lib/upload` pulls `api`
 * from the same mocked module, so no real network is touched.
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

const hoisted = vi.hoisted(() => ({
  fieldConfig: [] as EffectiveField[],
  questions: [] as TemplateQuestion[],
  submitBody: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (path === "/application-template") {
      return { questions: hoisted.questions, fieldConfig: hoisted.fieldConfig };
    }
    if (path === "/applications" && init?.method === "POST") {
      hoisted.submitBody = init.body as Record<string, unknown>;
      return {};
    }
    return {};
  }),
  ApiError: class ApiError extends Error {
    status: number;
    data: unknown;
    constructor(status = 500, message = "api error", data?: unknown) {
      super(message);
      this.status = status;
      this.data = data;
    }
  },
}));

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
// "city" as a *visible but optional* field, and omit every other built-in so
// it is treated as hidden. This keeps step 0 the only step with inputs.
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

async function fillCoreFields() {
  fireEvent.change(screen.getByLabelText(/First name/i), { target: { value: "Jane" } });
  fireEvent.change(screen.getByLabelText(/Last name/i), { target: { value: "Doe" } });
  fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: "jane@example.com" } });
  fireEvent.change(screen.getByLabelText(/Phone/i), { target: { value: "2145551234" } });
  fireEvent.change(screen.getByLabelText(/Street address/i), { target: { value: "1 Main St" } });
}

function clickContinue() {
  fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
}

beforeEach(() => {
  hoisted.fieldConfig = baseConfig();
  hoisted.questions = [];
  hoisted.submitBody = null;
});

describe("Apply wizard — hidden field settings", () => {
  it("does not render built-in fields the admin hid", async () => {
    render(<ApplyPage />);

    // Visible optional field renders.
    await waitFor(() => expect(screen.getByLabelText(/City/i)).toBeTruthy());

    // Hidden section-0 built-ins (date of birth, SSN, state, zip) must be gone
    // once the admin config is applied — they start visible from the static
    // defaults, then disappear.
    await waitFor(() => {
      expect(screen.queryByLabelText(/Date of birth/i)).toBeNull();
      expect(screen.queryByLabelText(/SSN \(last 4\)/i)).toBeNull();
      expect(screen.queryByLabelText(/^State$/i)).toBeNull();
      expect(screen.queryByLabelText(/ZIP code/i)).toBeNull();
    });
  });

  it("hides a whole section when all its fields are hidden", async () => {
    render(<ApplyPage />);
    await waitFor(() => expect(screen.getByLabelText(/City/i)).toBeTruthy());

    await fillCoreFields();
    clickContinue(); // -> step 1 (I-9 & Identity)

    // Section 1 has no visible fields, so the I-9 explainer / download link
    // must not render.
    await waitFor(() => expect(screen.getByText(/I-9 Employment Eligibility/i)).toBeTruthy());
    expect(screen.queryByText(/Download blank Form I-9/i)).toBeNull();
    expect(screen.queryByLabelText(/Completed Form I-9/i)).toBeNull();
  });
});

describe("Apply wizard — optional field settings", () => {
  it("lets the applicant advance and submit with a blank optional field", async () => {
    render(<ApplyPage />);
    await waitFor(() => expect(screen.getByLabelText(/City/i)).toBeTruthy());

    await fillCoreFields();
    // City left blank intentionally — it is optional.

    // Walk every step (5 Continues) then submit; nothing should block.
    for (let i = 0; i < 5; i++) clickContinue();

    fireEvent.click(screen.getByRole("button", { name: /Submit application/i }));

    await waitFor(() => expect(screen.getByText(/Thank you!/i)).toBeTruthy());
    expect(hoisted.submitBody).not.toBeNull();
  });
});

describe("Apply wizard — submitted payload", () => {
  it("omits blank optional built-ins but keeps the locked core fields", async () => {
    render(<ApplyPage />);
    await waitFor(() => expect(screen.getByLabelText(/City/i)).toBeTruthy());

    await fillCoreFields();
    for (let i = 0; i < 5; i++) clickContinue();
    fireEvent.click(screen.getByRole("button", { name: /Submit application/i }));

    await waitFor(() => expect(hoisted.submitBody).not.toBeNull());
    const body = hoisted.submitBody!;

    // Locked core fields are always present.
    expect(body.firstName).toBe("Jane");
    expect(body.lastName).toBe("Doe");
    expect(body.email).toBe("jane@example.com");
    expect(body.phone).toBe("2145551234");
    expect(body.address).toBe("1 Main St");

    // Blank optional built-in is omitted entirely (not ""/null).
    expect("city" in body).toBe(false);

    // Hidden built-ins of every shape are omitted — never sent as ""/0/null,
    // which would 400 against the optional (not nullish) Zod request schema.
    expect("zip" in body).toBe(false);
    expect("dateOfBirth" in body).toBe(false);
    expect("idDocType" in body).toBe(false); // enum-like field
    expect("siaLicenseLevel" in body).toBe(false); // numeric field
    expect("i9Doc" in body).toBe(false); // file field
    expect("references" in body).toBe(false);

    // No custom questions configured -> empty custom answers list.
    expect(body.customAnswers).toEqual([]);
  });

  it("includes an optional built-in once the applicant fills it in", async () => {
    render(<ApplyPage />);
    await waitFor(() => expect(screen.getByLabelText(/City/i)).toBeTruthy());

    await fillCoreFields();
    fireEvent.change(screen.getByLabelText(/City/i), { target: { value: "Dallas" } });
    for (let i = 0; i < 5; i++) clickContinue();
    fireEvent.click(screen.getByRole("button", { name: /Submit application/i }));

    await waitFor(() => expect(hoisted.submitBody).not.toBeNull());
    expect(hoisted.submitBody!.city).toBe("Dallas");
  });
});

describe("Apply wizard — custom questions", () => {
  it("renders admin-defined custom questions on their own step", async () => {
    hoisted.questions = [
      {
        id: "q-vehicle",
        label: "Do you have a reliable vehicle?",
        helpText: null,
        fieldType: "yes_no",
        required: false,
        options: null,
        sortOrder: 0,
        enabled: true,
      },
    ];

    render(<ApplyPage />);
    await waitFor(() => expect(screen.getByLabelText(/City/i)).toBeTruthy());

    // The extra "Additional questions" step appears in the stepper once the
    // template loads.
    await waitFor(() => expect(screen.getByText(/Additional questions/i)).toBeTruthy());

    await fillCoreFields();
    // Steps 0..4 -> reach the "Additional questions" step (index 5).
    for (let i = 0; i < 5; i++) clickContinue();

    expect(screen.getByText(/Do you have a reliable vehicle\?/i)).toBeTruthy();
  });
});
