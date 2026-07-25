---
name: Brand schema version skew
description: New brandConfigSchema fields must be .optional() or stale clients 400 on brand saves
---

Any NEW field added to `brandConfigSchema` (shared by the in-app super-admin PUT and the remote control-plane HMAC PUT) must be `.optional()`, not just `.nullable()`.

**Why:** The control plane is deployed as a separate Replit project and admin-portal bundles can be cached. A `.nullable()`-only field makes the key REQUIRED in the PUT body, so every brand save from a not-yet-redeployed client fails 400 (caught live when `companyLicense` was added — the control-plane HMAC test PUT, written before the field existed, went 400). Absent key = "leave unchanged" is the correct skew-tolerant semantic (drizzle skips undefined columns on update).

**How to apply:** When adding a brand field: `blankToNull(z.string().max(N).nullable().optional())`. Also remember email.ts bulk signature replacements: 4 email SUBJECT lines also match the `— ${brand.companyName}` pattern — subjects must stay plain company name, so audit subjects after any replace_all on signature strings.

**Same rule for `customerConfigSchema`** (plan/commercial config, shared by the in-app `PUT /admin/platform/customer-config` and the remote `PUT /control-plane/customer-config`): every field is `.nullable().optional()`, and both routes write via `pickCustomerConfigColumns()` which emits ONLY keys present in the payload (absent key = leave unchanged). This is what lets the separately-deployed Control Plane's "Plan & Billing" panel save without clobbering fields a skewed version doesn't know. Live-apply hooks (`applyProcessingFeeConfig` + `applyConfirmEditWindowConfig`) must run on BOTH routes so the processing fee + officer time-edit window take effect with no restart.
