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
 * Extension → MIME map for the server's accepted upload inputs. iPhone photos
 * (`.heic`/`.heif`) are included: the API accepts them and transcodes to JPEG.
 */
const EXT_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  txt: "text/plain",
};

/**
 * Resolve a usable Content-Type for an upload.
 *
 * Browsers frequently report an empty or generic `application/octet-stream`
 * type for Word documents (`.doc`/`.docx`) and any file whose extension the
 * OS hasn't registered. The server validates uploads against a strict MIME
 * allow-list, so an empty/generic type is rejected with 415. Fall back to the
 * file extension so legitimate resumes and documents still upload.
 */
export function resolveContentType(file: File): string {
  const declared = file.type?.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream") return declared;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_CONTENT_TYPES[ext] ?? declared ?? "application/octet-stream";
}

/**
 * Request a presigned URL via the given API path, then PUT the file directly
 * to the returned GCS signed URL.
 */
async function uploadFileTo(file: File, endpoint: string): Promise<UploadedFile> {
  const meta = {
    name: file.name,
    size: file.size,
    contentType: resolveContentType(file),
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
 * Authenticated upload for the subcontractor self-service portal. Uses its
 * own request-url endpoint (requireSubcontractor, not requireStaff) since
 * subcontractor accounts are an external role excluded from the generic
 * staff upload path.
 */
export async function uploadFileSubcontractor(file: File): Promise<UploadedFile> {
  return uploadFileTo(file, "/subcontractor-portal/uploads/request-url");
}

/**
 * Open a subcontractor's own uploaded document (W-9, COI PDF) in a new tab.
 * Signs via the subcontractor-scoped endpoint, which proves ownership by
 * the `/objects/uploads/u/<userId>/` key prefix rather than a DB lookup.
 */
export async function openSignedObjectSubcontractor(objectPath: string): Promise<void> {
  const win = window.open("", "_blank");
  try {
    const { url } = await api<{ url: string }>(`/subcontractor-portal/storage/sign?path=${encodeURIComponent(objectPath)}`);
    if (win) win.location.href = url;
    else window.open(url, "_blank");
  } catch (e) {
    if (win) win.close();
    alert(`Failed to open file: ${(e as Error).message}`);
  }
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
  const contentType = resolveContentType(file);

  /**
   * Applicants are anonymous members of the public filling in a long form, so a
   * failed document upload is where we lose them entirely — they have no
   * account, no support channel, and no way to retry later. Two things matter
   * here beyond the happy path:
   *
   *  - Retry transient failures. A 5xx or a dropped connection is routinely
   *    momentary (a backend redeploy restarts the server for a few seconds, and
   *    every request in that window 5xxs). Re-sending a second later almost
   *    always succeeds, and the applicant never sees it. 4xx is *not* retried:
   *    the file is wrong and resending cannot change that.
   *  - Never surface a bare status code. An error the applicant cannot act on
   *    is indistinguishable from the app being broken.
   */
  let res: Response | undefined;
  let networkError: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    networkError = undefined;
    try {
      res = await fetch("/api/storage/uploads/application-file", {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "X-File-Name": file.name,
        },
        body: file,
      });
    } catch (e) {
      // Network-level failure (offline, connection reset mid-upload).
      networkError = e;
    }

    const retriable = networkError !== undefined || (res !== undefined && res.status >= 500);
    if (!retriable) break;
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 800));
  }

  if (!res) {
    throw new Error(
      "Upload failed — we couldn't reach the server. Check your connection and try again.",
    );
  }

  if (!res.ok) {
    // A 5xx often isn't JSON at all (a proxy error page during a restart), so
    // fall back to an explanation rather than the status number.
    const body = await res.json().catch(() => ({})) as { message?: string };
    if (body.message) throw new Error(body.message);
    throw new Error(
      res.status >= 500
        ? "Upload failed — the server is temporarily unavailable. Please wait a moment and try again."
        : `Upload failed (${res.status})`,
    );
  }

  const data = await res.json() as { objectPath: string; name: string; size: number; contentType: string };
  return {
    name: data.name,
    objectPath: data.objectPath,
    contentType: data.contentType,
    size: data.size,
  };
}
