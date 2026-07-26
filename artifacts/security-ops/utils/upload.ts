import * as ImagePicker from "expo-image-picker";
import { apiRequest } from "@/utils/api";

export type UploadedFile = {
  name: string;
  objectPath: string;
  contentType: string;
  size: number;
  /** Local URI of the source asset; useful for instant preview before the
   * server round-trip. Same `uri` returned by expo-image-picker. */
  localUri: string;
};

/**
 * Pick an image (camera roll or camera) and upload via the same presigned-URL
 * flow used by the admin portal: POST metadata to /storage/uploads/request-url,
 * then PUT the file blob directly to the returned signed URL.
 *
 * Returns the resulting `objectPath` (e.g. "/objects/<uuid>") which is what
 * the employees table stores for *DocKey columns. Returns null if the user
 * cancelled or denied permission.
 */
export async function pickAndUploadImage(opts?: {
  source?: "library" | "camera";
  /** Compress images so officer phones don't blow our object storage budget. */
  quality?: number;
}): Promise<UploadedFile | null> {
  const source = opts?.source ?? "library";
  const quality = opts?.quality ?? 0.7;

  if (source === "camera") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error("Camera permission denied");
  }
  // For the library source we deliberately do NOT request a media-library
  // permission: launchImageLibraryAsync() uses the OS system photo picker
  // (Android Photo Picker / iOS PHPicker), which runs out-of-process, lets the
  // user pick exactly what to share, and needs no READ_MEDIA_* permission.
  // Google Play rejects apps that request READ_MEDIA_IMAGES/READ_MEDIA_VIDEO
  // when the system picker is sufficient — which it is here (single-image pick).

  const result = source === "camera"
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality, allowsEditing: false })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality, allowsEditing: false });

  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  return uploadAssetUri({
    uri: asset.uri,
    name: asset.fileName ?? `upload-${Date.now()}.jpg`,
    contentType: asset.mimeType ?? "image/jpeg",
    size: asset.fileSize ?? 0,
  });
}

/**
 * Upload a local file URI (from a picker) using the presigned-URL flow.
 * Exposed separately so callers can plug in other pickers later
 * (e.g. expo-document-picker for PDFs) without re-implementing the request.
 */
export async function uploadAssetUri(asset: {
  uri: string;
  name: string;
  contentType: string;
  size: number;
}): Promise<UploadedFile> {
  // 1) Read the local file as a Blob (works on both native + web).
  const blob = await (await fetch(asset.uri)).blob();
  const finalSize = asset.size > 0 ? asset.size : blob.size;
  const finalType = asset.contentType || blob.type || "application/octet-stream";

  // 2) Request a presigned upload URL from the API server.
  const meta = { name: asset.name, size: finalSize, contentType: finalType };
  const { uploadURL, objectPath } = await apiRequest("/storage/uploads/request-url", {
    method: "POST",
    body: JSON.stringify(meta),
  }) as { uploadURL: string; objectPath: string };

  // 3) PUT the bytes straight to GCS — same as the web flow.
  const put = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": finalType },
    body: blob,
  });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  return { name: asset.name, objectPath, contentType: finalType, size: finalSize, localUri: asset.uri };
}

/**
 * Build a short-lived signed URL the employee can use to preview a doc they
 * uploaded. We reuse the admin signer (the route is admin-only); for
 * employees we render a "View current file" indicator instead. Kept here so
 * the shape stays consistent with `utils/upload`.
 */
export function isObjectPath(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("/objects/");
}
