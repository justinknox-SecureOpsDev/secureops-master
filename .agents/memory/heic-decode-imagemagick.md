---
name: HEIC decode needs ImageMagick, not sharp
description: iPhone HEIC (HEVC) cannot be decoded by this env's sharp; ImageMagick does it; keep imagemagick a declared dep and mirror upload type lists across all surfaces.
---

# iPhone HEIC uploads decode via ImageMagick, not sharp

**Constraint:** This environment's `sharp`/libvips is built with **AVIF-only** HEIF
support (no HEVC codec). It will `metadata()` a HEIF container and even report
`compression: "hevc"`, but **`.toBuffer()` pixel decode of a real iPhone HEIC
fails** ("bad seek to 1024"). ImageMagick's libheif carries the HEVC decoder and
round-trips HEIC fine. ffmpeg has an HEVC *decoder* but **can't demux the HEIF
still-image container** here, so it is not a fallback.

**Why:** iPhones photograph IDs / SSN cards as HEIC (HEVC). The anonymous HR
application upload endpoint (`POST /api/storage/uploads/application-file`, shared by
Apply / Onboard / Amend) must accept and store a browser-viewable image. Accepting
HEIC but decoding with sharp = accept-then-422, i.e. the "can't upload driver's
license" complaint never actually goes away. Root cause was NOT the type allow-list
alone — it was the decoder.

**How to apply:**
- HEIC/HEIF decode = shell out to ImageMagick (`magick heic:- -auto-orient -strip
  -resize 3000x3000> -quality 82 jpeg:-`), fed via stdin, resource-limited with
  `MAGICK_*_LIMIT` env vars + a wall-clock kill + output-size cap. This endpoint is
  **unauthenticated**, so the transcode must be bounded (decompression bomb / CPU).
  Other raster types stay on sharp (fast native), with `limitInputPixels` set.
- `imagemagick` must stay a **declared** Nix system dep (`replit.nix`). It is present
  in dev only *transitively* otherwise, so removing the declaration would break HEIC
  decode in the deployed VM while dev still works.
- Any change to accepted upload types must be mirrored across EVERY surface or
  something 415s / stores an unviewable blob: client `EXT_CONTENT_TYPES`
  (admin-portal upload lib), server `EXTENSION_CONTENT_TYPES` +
  `ALLOWED_CONTENT_TYPES` / `CONVERTIBLE_IMAGE_TYPES` + `RASTER_IMAGE_TYPES`, and the
  `<input accept>` attrs on Apply.tsx (Onboard/Amend rely on the server fix).
- To prove a real HEIC works (sandbox has no iPhone), generate a genuine HEVC fixture
  with `magick png:- heic:-` — sharp cannot decode it, which is exactly the point —
  then assert the pipeline returns a JPEG. A live curl of a real HEIC to the running
  endpoint (both `image/heic` and `application/octet-stream`) is the true E2E check.
