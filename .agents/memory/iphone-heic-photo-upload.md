---
name: iPhone HEIC photo upload 415
description: Why iOS mobile photo uploads fail with 415, and the OTA-safe fix (picker Compatible mode + server HEIC accept)
---

# iPhone HEIC photo uploads fail with 415

iPhones capture photos as HEIC by default. `expo-image-picker` does NOT always
transcode to JPEG: with `quality < 1` (we use 0.7) the library (PHPicker) path
skips its fast-path and hits `readDataAndFileExtension`, which has an explicit
`UTType.heic` case that returns the RAW HEIC bytes with a `.heic` extension and
`mimeType: image/heic` — only the `default:` branch JPEG-re-encodes. So library
picks arrive as genuine HEIC bytes, and the API storage allow-list (jpeg/png/
gif/webp/pdf/doc/txt) rejects them with **415** on `POST /api/storage/uploads/request-url`.
(The camera path uses UIImagePickerController, whose handler JPEG-encodes in its
default case, so camera was never the culprit — only library picks.)

**Fix = two layers:**
- **Client (primary, OTA-safe):** pass `preferredAssetRepresentationMode: UIImagePickerPreferredAssetRepresentationMode.Compatible` to `launchImageLibraryAsync`. This is a *runtime* picker field already compiled into the shipped native binary — it makes iOS PHPicker deliver the JPEG representation at pick time, so bytes+mimeType become real web-viewable JPEG. **No native rebuild → ships via expo-updates OTA.** (Do NOT add `expo-image-manipulator` — that's a native module and would need a full rebuild, defeating OTA.)
- **Server (defense-in-depth):** accept `image/heic`+`image/heif` in the storage allow-list + extension map so already-installed pre-OTA clients stop hard-failing. Trade-off: HEIC stored by old clients won't render in the admin portal on Chrome/Firefox (Safari is fine); volume shrinks as OTA propagates.

**Why:** the request-url flow PUTs bytes straight to GCS — the server never sees
the bytes, so it cannot transcode; it can only accept or reject the content type.
The GCS signed PUT signs only method+expiry (no content-type binding), so any
Content-Type header on the PUT is accepted.

**How to apply:** any new mobile image-upload surface must go through
`utils/upload.ts::pickAndUploadImage` (already carries the Compatible option).
If admins ever report broken HEIC previews on web, the follow-up is a
signed-download transcode via `sharp` (see `lib/watermark.ts` heif→JPEG), not a
client change.
