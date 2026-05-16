import { api } from "./api";

/** Open a private uploaded object in a new tab via short-lived signed URL. */
export async function openSignedObject(objectPath: string): Promise<void> {
  const win = window.open("", "_blank");
  try {
    const { url } = await api<{ url: string }>(`/admin/storage/sign?path=${encodeURIComponent(objectPath)}`);
    if (win) win.location.href = url;
    else window.open(url, "_blank");
  } catch (e) {
    if (win) win.close();
    alert(`Failed to open file: ${(e as Error).message}`);
  }
}

export type UploadedFile = {
  name: string;
  objectPath: string;
  contentType: string;
  size: number;
};

/**
 * Request a presigned URL via the given API path, then PUT the file directly
 * to the returned GCS signed URL.
 */
async function uploadFileTo(file: File, endpoint: string): Promise<UploadedFile> {
  const meta = {
    name: file.name,
    size: file.size,
    contentType: file.type || "application/octet-stream",
  };
  const { uploadURL, objectPath } = await api<{ uploadURL: string; objectPath: string }>(
    endpoint,
    { method: "POST", body: meta },
  );
  const put = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": meta.contentType },
    body: file,
  });
  if (!put.ok) {
    throw new Error(`Upload failed (${put.status})`);
  }
  return { ...meta, objectPath };
}

/**
 * Authenticated upload — requires a valid JWT in localStorage.
 * Used by admin and employee screens where the caller is always logged in.
 */
export async function uploadFile(file: File): Promise<UploadedFile> {
  return uploadFileTo(file, "/storage/uploads/request-url");
}

/**
 * Anonymous upload for the public HR pipeline (Apply / Onboard / Amend).
 *
 * Unlike the authenticated flow (presigned PUT URL → direct GCS write),
 * this sends the file bytes *through* the API server so that size and
 * content-type are enforced at the HTTP layer before anything reaches
 * object storage. No auth token is required.
 *
 * The API enforces: 10 MB body limit, MIME allow-list, per-IP rate limit.
 */
export async function uploadFileAnon(file: File): Promise<UploadedFile> {
  const contentType = file.type || "application/octet-stream";

  const res = await fetch("/api/storage/uploads/application-file", {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-File-Name": file.name,
    },
    body: file,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `Upload failed (${res.status})`);
  }

  const data = await res.json() as { objectPath: string; name: string; size: number; contentType: string };
  return {
    name: data.name,
    objectPath: data.objectPath,
    contentType: data.contentType,
    size: data.size,
  };
}
