import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatgptFetch, chatgptSearch, documentUrl } from "../src/chatgpt.js";
import type { HttpConfig } from "../src/config.js";
import { isAuthorized, isAuthorizedHeader, parseBearer, verifyLoginPassword } from "../src/httpAuth.js";
import { startHttpServer } from "../src/httpServer.js";
import { KnowledgeStore } from "../src/knowledgeStore.js";
import { buildMcpServer } from "../src/server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function makeStore(): Promise<KnowledgeStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-http-vault-"));
  const patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-http-patches-"));
  await fs.cp(path.join(repoRoot, "fixtures", "synthetic-vault"), root, { recursive: true });
  const store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
  await store.init();
  return store;
}

describe("httpAuth", () => {
  it("parses bearer tokens case-insensitively and rejects malformed headers", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer("bearer   abc123")).toBe("abc123");
    expect(parseBearer("Bearer\tabc123")).toBe("abc123");
    expect(parseBearer("Basic abc123")).toBeNull();
    expect(parseBearer("Bearer ")).toBeNull();
    expect(parseBearer("Bearerabc")).toBeNull(); // no separator
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer(null)).toBeNull();
    // Linear-time on pathological all-separator input (ReDoS guard).
    const start = Date.now();
    expect(parseBearer("Bearer" + "\t".repeat(100000))).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("authorizes only an exact token match (constant-time)", () => {
    expect(isAuthorized("secret-token", "secret-token")).toBe(true);
    expect(isAuthorized("secret-token", "wrong-token")).toBe(false);
    expect(isAuthorized("secret", "secret-token")).toBe(false); // length mismatch handled
    expect(isAuthorized("", "secret-token")).toBe(false);
    expect(isAuthorized(null, "secret-token")).toBe(false);
    expect(isAuthorized("secret-token", "")).toBe(false);
  });

  it("authorizes from a header value end to end", () => {
    expect(isAuthorizedHeader("Bearer secret-token", "secret-token")).toBe(true);
    expect(isAuthorizedHeader("Bearer nope", "secret-token")).toBe(false);
    expect(isAuthorizedHeader(undefined, "secret-token")).toBe(false);
  });

  it("verifies the OAuth login password with a slow KDF", () => {
    expect(verifyLoginPassword("hunter2", "hunter2")).toBe(true);
    expect(verifyLoginPassword("hunter2", "hunter3")).toBe(false);
    expect(verifyLoginPassword("", "hunter2")).toBe(false);
    expect(verifyLoginPassword(null, "hunter2")).toBe(false);
    expect(verifyLoginPassword("hunter2", "")).toBe(false);
  });
});

describe("chatgpt adapters", () => {
  let store: KnowledgeStore;
  beforeEach(async () => {
    store = await makeStore();
  });

  it("documentUrl encodes segments under a configurable base", () => {
    expect(documentUrl("projects/claude/a b.md")).toBe("vault://projects/claude/a%20b.md");
    expect(documentUrl("a/b.md", "https://notes.example.com")).toBe("https://notes.example.com/a/b.md");
  });

  it("search returns the ChatGPT { results: [{id,title,url}] } shape", async () => {
    const out = await chatgptSearch(store, "retrieval");
    expect(out).toHaveProperty("results");
    expect(Array.isArray(out.results)).toBe(true);
    for (const r of out.results) {
      expect(r).toMatchObject({ id: expect.any(String), title: expect.any(String), url: expect.any(String) });
    }
  });

  it("fetch returns the ChatGPT { id,title,text,url,metadata } shape", async () => {
    const result = await chatgptFetch(store, "chatgpt-research-001");
    expect(result.id).toBe("chatgpt-research-001");
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.url.startsWith("vault://")).toBe(true);
    // metadata values are all strings per the contract
    for (const value of Object.values(result.metadata)) {
      expect(typeof value).toBe("string");
    }
  });

  it("fetch rejects unknown ids", async () => {
    await expect(chatgptFetch(store, "does-not-exist")).rejects.toThrow();
  });
});

describe("buildMcpServer tool surface", () => {
  async function toolNames(allowWrite: boolean): Promise<string[]> {
    const store = await makeStore();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(store, { allowWrite, includeChatgptCompat: true });
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => t.name).sort();
  }

  it("omits write tools when allowWrite is false (read-only HTTP default)", async () => {
    const names = await toolNames(false);
    expect(names).toContain("search_documents");
    expect(names).toContain("search");
    expect(names).toContain("fetch");
    expect(names).not.toContain("create_document");
    expect(names).not.toContain("plan_document_update");
    expect(names).not.toContain("apply_planned_update");
  });

  it("includes write tools when allowWrite is true (stdio / opt-in)", async () => {
    const names = await toolNames(true);
    expect(names).toContain("create_document");
    expect(names).toContain("plan_document_update");
    expect(names).toContain("apply_planned_update");
  });

  it("advertises readOnlyHint so clients can skip per-call approval on reads", async () => {
    const store = await makeStore();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(store, { allowWrite: true, includeChatgptCompat: true });
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();

    const hint = (name: string) => tools.find((t) => t.name === name)?.annotations?.readOnlyHint;
    // Every read tool is marked read-only so clients (e.g. Claude.ai) can auto-run
    // it instead of prompting "allow once?" on every call.
    for (const name of ["search_documents", "fetch_document", "list_projects", "trace_sources", "search", "fetch"]) {
      expect(hint(name)).toBe(true);
    }
    // Write tools deliberately carry no readOnlyHint, so clients keep prompting
    // for approval before any mutation.
    for (const name of ["create_document", "plan_document_update", "apply_planned_update"]) {
      expect(hint(name)).not.toBe(true);
    }
  });

  it("puts ChatGPT payloads at structuredContent top level, wraps native arrays under data", async () => {
    const store = await makeStore();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(store, { allowWrite: false, includeChatgptCompat: true });
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);

    const search = await client.callTool({ name: "search", arguments: { query: "retrieval" } });
    expect((search.structuredContent as { results?: unknown[] }).results).toBeDefined();

    const hit = (search.structuredContent as { results: Array<{ id: string }> }).results[0];
    const fetched = await client.callTool({ name: "fetch", arguments: { id: hit.id } });
    expect((fetched.structuredContent as { id?: string }).id).toBe(hit.id);

    // Native tool returns an array -> wrapped under data (structuredContent must be an object)
    const native = await client.callTool({ name: "search_documents", arguments: { query: "retrieval" } });
    expect(Array.isArray((native.structuredContent as { data?: unknown[] }).data)).toBe(true);

    await client.close();
  });
});

describe("HTTP transport integration", () => {
  let server: http.Server | undefined;
  let baseUrl = "";
  let config: HttpConfig;
  const token = "test-secret-token";

  beforeEach(async () => {
    const store = await makeStore();
    config = {
      host: "127.0.0.1",
      port: 0,
      authToken: token,
      allowWrite: false,
      allowedHosts: [],
      allowedOrigins: []
    };
    server = await startHttpServer(store, config);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    // allowedHosts is read per-request at session init; populate now that the
    // ephemeral port is known so DNS-rebinding protection accepts the client.
    config.allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("serves an unauthenticated health probe", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects MCP requests without a valid bearer token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    expect(res.status).toBe(401);

    const wrong = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer nope"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    expect(wrong.status).toBe(401);
  });

  it("completes the MCP handshake with a valid token and exposes read-only tools", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("search");
    expect(names).toContain("fetch");
    expect(names).not.toContain("create_document");

    // ChatGPT contract: payload (results) lives at structuredContent top level.
    const result = await client.callTool({ name: "search", arguments: { query: "retrieval" } });
    const structured = result.structuredContent as { results: unknown[] } | undefined;
    expect(structured?.results).toBeDefined();
    expect(Array.isArray(structured?.results)).toBe(true);

    await client.close();
  });
});
