---
name: Org backend Wi‑Fi blocking
description: Troubleshooting when organization lookup succeeds but the tenant login or brand request times out on one device.
---

If the central organization directory resolves successfully but the selected tenant's login or branding request times out for only one user, test the phone on cellular before changing credentials, tenant data, or app code. The directory and tenant backend may be separate domains, so a filtered Wi‑Fi network can allow the lookup while blocking the actual customer backend.

**Why:** A real RGP incident showed “Connected to RGP” with the platform fallback brand and a timeout; the RGP server responded immediately from outside the affected network, and cellular access fixed the login.

**How to apply:** Compare the tenant backend URL against a direct external request, then have the user retry with Wi‑Fi disabled. If cellular works, investigate Wi‑Fi filtering, VPN, DNS, or device management rather than account state.