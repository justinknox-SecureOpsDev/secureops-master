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

/** Request a presigned URL, then PUT the file directly to it. */
export async function uploadFile(file: File): Promise<UploadedFile> {
  const meta = {
    name: file.name,
    size: file.size,
    contentType: file.type || "application/octet-stream",
  };
  const { uploadURL, objectPath } = await api<{ uploadURL: string; objectPath: string }>(
    "/storage/uploads/request-url",
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
