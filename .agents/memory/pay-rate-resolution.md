---
name: Officer pay-rate resolution
description: Precedence and zero-means-unset rule for officer pay; one shared resolver.
---

Officer pay precedence: per-entry admin override > employee profile rate > shift rate, else $0 (which keeps the "$0 rate" warning). "Set" means present AND > 0 at every level.

**Why:** the shift rate column is NOT NULL DEFAULT '0', so any `??`-coalescing chain lets a $0 shift rate beat a real profile rate (officers silently paid $0). Duplicated inline chains drifted across payroll/analytics before, so the chain lives in one shared resolver (grep for it) that also owns the holiday 1.5× cents-first rounding.

**How to apply:** never re-implement the chain or use `??` for pay rates — call the shared resolver, passing the clock-in/start instant so holiday premiums match payroll. Officer-facing responses substitute the resolved rate only for the officer's own view; admin/dispatcher management views keep the shift's configured rate. Client billing (bill rates) is a separate chain — untouched by this rule.
