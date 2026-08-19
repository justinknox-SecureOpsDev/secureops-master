---
name: Admin portal parallel-test timeouts
description: How to distinguish Admin Portal UI timeouts under the workspace-wide test gate from a product regression.
---

Admin Portal UI tests that time out at Vitest's five-second limit during `pnpm -r --if-present run test` can be resource-contention flakes when other workspace packages are running at the same time. If the affected tests pass one-by-one, treat the workspace-gate result as parallel-load flakiness rather than changing unrelated product code.

**Why:** independent UI tests have passed in isolation immediately after all timing out together only during the parallel workspace validation run.

**How to apply:** inspect the gate log for five-second timeouts, then rerun each affected Admin Portal test file individually. Do not alter the API or unrelated UI behavior solely to chase that parallel-load failure.