---
name: chatRoomAccess test timeout flake
description: chatRoomAccess.test.ts times out under the full parallel test gate but passes alone
---

`artifacts/api-server/src/__tests__/chatRoomAccess.test.ts` runs ~29s of test time in isolation — right at the 30s vitest timeout. Under the full `pnpm -r --if-present run test` validation gate (CPU contention from parallel suites) it can exceed 30s and fail with a timeout.

**Why:** bcrypt hashing + many sequential HTTP round-trips make it the slowest api-server suite; contention pushes it over the limit.

**How to apply:** if the only test-gate failure is a chatRoomAccess timeout and you did not touch chat/room-access code, verify it passes in isolation and treat it as a pre-existing flake, not a regression.
