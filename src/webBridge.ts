import type http from "node:http";

/**
 * node:http <-> Web-standard Request/Response bridge.
 *
 * The `@modelcontextprotocol/server` v2 line is written against Web standards
 * (`Request` / `Response` / `ReadableStream`) so the same code runs on Workers,
 * Deno and Bun. This server is plain `node:http` with no Express and no Hono in
 * the dependency tree, so the two shapes are joined here.
 *
 * This module is deliberately POLICY-FREE: it only converts shapes. Every
 * security decision (bearer auth, Host / Origin validation, era routing,
 * scope -> tool surface) stays in `httpServer.ts`, where the order the gates run
 * in can be read top to bottom (INV-6).
 */

/**
 * Build a Web `Request` from a Node request plus its ALREADY-READ body.
 *
 * The body is passed in rather than streamed because the size cap (INV-6 item 5)
 * has to be enforced while reading, and because both the era classifier and the
 * handler need the same bytes — a `Request` body can only be consumed once.
 */
export function toWebRequest(req: http.IncomingMessage, body: Buffer | undefined): Request {
  // The Host header is attacker-controlled; it is only used here to make the URL
  // parseable. Host validation happens separately, before dispatch.
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  const method = req.method ?? "GET";
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD" && body && body.length > 0) {
    init.body = new Uint8Array(body);
  }
  return new Request(url, init);
}

/**
 * Write a Web `Response` out over a Node response.
 *
 * Streams the body chunk by chunk so a held-open SSE stream (the 2025-era GET
 * stream, and modern streaming responses) is forwarded as it is produced rather
 * than buffered. If the client goes away mid-stream the reader is cancelled, so
 * a vanished client cannot pin the producing side open.
 */
export async function sendWebResponse(res: http.ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === "set-cookie") {
      const existing = headers[key];
      headers[key] = Array.isArray(existing) ? [...existing, value] : existing ? [String(existing), value] : [value];
      return;
    }
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  let clientGone = false;
  const onClose = () => {
    clientGone = true;
    void reader.cancel().catch(() => {});
  };
  res.on("close", onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || clientGone) {
        break;
      }
      if (value) {
        res.write(Buffer.from(value));
      }
    }
  } finally {
    res.off("close", onClose);
    if (!res.writableEnded) {
      res.end();
    }
  }
}
