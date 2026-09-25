import type { FileUIPart, UIMessage } from "ai";

/**
 * Attachments live in R2, not in the chat transcript. The browser uploads the
 * file first, then sends a message whose file part points at /api/files/<key>.
 * The transcript stays small and every file is cached at the edge.
 * https://developers.cloudflare.com/r2/api/workers/workers-api-usage/
 */
const PREFIX = "/api/files/";
const MAX_BYTES = 20 * 1024 * 1024;

export async function handleFiles(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/files") {
    const name = url.searchParams.get("name") ?? "file";
    const mediaType = request.headers.get("content-type") ?? "application/octet-stream";
    const size = Number(request.headers.get("content-length") ?? 0);
    if (size > MAX_BYTES) return Response.json({ error: "File is larger than 20 MB" }, { status: 413 });

    const key = `uploads/${crypto.randomUUID()}/${encodeURIComponent(name)}`;
    await env.FILES.put(key, request.body, { httpMetadata: { contentType: mediaType } });
    return Response.json({ url: `${PREFIX}${key}`, mediaType, filename: name });
  }

  if (request.method === "GET" && url.pathname.startsWith(PREFIX)) {
    const object = await env.FILES.get(url.pathname.slice(PREFIX.length));
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "cache-control": "private, max-age=31536000, immutable"
      }
    });
  }

  return new Response("Not found", { status: 404 });
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|x-yaml|yaml))/;

/**
 * Before the model sees the conversation, swap each R2 reference for the file's
 * bytes: images and PDFs become data URLs (the model reads them natively),
 * text files become plain text parts (most models reject text/* file parts).
 */
export async function inlineAttachments(messages: UIMessage[], env: Env): Promise<UIMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (!message.parts.some(isStoredFile)) return message;
      const parts = await Promise.all(
        message.parts.map(async (part) => {
          if (!isStoredFile(part)) return part;
          const object = await env.FILES.get(part.url.slice(PREFIX.length));
          if (!object) return { type: "text" as const, text: `[Attachment ${part.filename ?? ""} is missing]` };
          if (TEXT_TYPES.test(part.mediaType)) {
            return { type: "text" as const, text: `Attached file "${part.filename}":\n\n${await object.text()}` };
          }
          const base64 = toBase64(new Uint8Array(await object.arrayBuffer()));
          return { ...part, url: `data:${part.mediaType};base64,${base64}` };
        })
      );
      return { ...message, parts };
    })
  );
}

function isStoredFile(part: UIMessage["parts"][number]): part is FileUIPart {
  return part.type === "file" && part.url.startsWith(PREFIX);
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
