import type { FileUIPart } from "ai";

/**
 * Upload each attachment to R2 (via /api/files) and return file parts that
 * point at the stored copy. The chat message then carries a short URL instead
 * of megabytes of base64.
 */
export async function uploadAttachments(files: FileUIPart[]): Promise<FileUIPart[]> {
  return Promise.all(
    files.map(async (file) => {
      const blob = await (await fetch(file.url)).blob();
      const name = file.filename ?? "attachment";
      const res = await fetch(`/api/files?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": file.mediaType || blob.type || "application/octet-stream" },
        body: blob
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(error ?? `Upload failed (${res.status})`);
      }
      const stored = (await res.json()) as { url: string; mediaType: string; filename: string };
      return { type: "file", url: stored.url, mediaType: stored.mediaType, filename: stored.filename };
    })
  );
}
