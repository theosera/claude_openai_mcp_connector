import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernStreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatgptFetch, chatgptSearch, documentUrl } from "../src/chatgpt.js";
import type { HttpConfig } from "../src/config.js";
import { isAuthorized, isAuthorizedHeader, parseBearer, verifyLoginPassword } from "../src/httpAuth.js";
import { hostnameOf, startHttpServer } from "../src/httpServer.js";
import { KnowledgeStore } from "../src/knowledgeStore.js";
import { AuditStore } from "../src/auditStore.js";
import { buildMcpServer, SERVER_INSTRUCTIONS, type BuildServerOptions } from "../src/server.js";
import { SkillStore } from "../src/skillStore.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function makeStore(): Promise<KnowledgeStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-http-vault-"));
  const patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-http-patches-"));
  await fs.cp(path.join(repoRoot, "fixtures", "synthetic-vault"), root, { recursive: true });
  const store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
  await store.init();
  return store;
}

async function makeAuditStore(): Promise<AuditStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-http-audit-vault-"));
  await fs.mkdir(path.join(root, "90_Audit", "vault-scan"), { recursive: true });
  const auditStore = new AuditStore({ knowledgeRoot: root, auditSubdir: "90_Audit/vault-scan" });
  await auditStore.init();
  return auditStore;
}

async function toolNamesWith(store: KnowledgeStore, options: BuildServerOptions): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(store, options);
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((tool) => tool.name);
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
    expect(names).not.toContain("plan_document_create");
    expect(names).not.toContain("apply_planned_document_create");
    expect(names).not.toContain("plan_document_update");
    expect(names).not.toContain("apply_planned_update");
  });

  it("includes write tools when allowWrite is true (stdio / opt-in)", async () => {
    const names = await toolNames(true);
    expect(names).toContain("create_document");
    expect(names).toContain("plan_document_create");
    expect(names).toContain("apply_planned_document_create");
    expect(names).toContain("plan_document_update");
    expect(names).toContain("apply_planned_update");
  });

  it("exposes only Skill writes when the dedicated flag and store are present", async () => {
    const store = await makeStore();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-http-skill-vault-"));
    const patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-http-skill-patches-"));
    await fs.mkdir(path.join(root, "skills"));
    const skillStore = new SkillStore({ knowledgeRoot: root, skillsSubdir: "skills", patchStateDir });
    await skillStore.init();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(store, {
      allowWrite: false,
      allowSkillWrite: true,
      skillStore,
      includeChatgptCompat: true
    });
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("plan_skill_create");
    expect(names).toContain("apply_planned_skill_create");
    expect(names).not.toContain("create_document");
    expect(names).not.toContain("plan_document_create");
    expect(names).not.toContain("apply_planned_document_create");
    expect(names).not.toContain("plan_document_update");
    expect(names).not.toContain("apply_planned_update");
  });

  it("does not expose Skill tools without an initialized Skill store", async () => {
    const store = await makeStore();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(store, {
      allowWrite: false,
      allowSkillWrite: true,
      includeChatgptCompat: true
    });
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((tool) => tool.name)).not.toContain("plan_skill_create");
  });

  it("exposes audit tools but NOT general write tools on a scan endpoint", async () => {
    // The security win: a scan endpoint sets allowAuditWrite WITHOUT allowWrite,
    // so an unattended (possibly injected) scanner can persist audit output but
    // has no general document-write tools to be steered into (confused-deputy).
    const names = await toolNamesWith(await makeStore(), {
      allowWrite: false,
      allowAuditWrite: true,
      auditStore: await makeAuditStore(),
      includeChatgptCompat: true
    });
    expect(names).toContain("append_audit_report");
    expect(names).toContain("compare_and_swap_audit_state");
    expect(names).not.toContain("create_document");
    expect(names).not.toContain("plan_document_create");
    expect(names).not.toContain("apply_planned_document_create");
    expect(names).not.toContain("plan_document_update");
    expect(names).not.toContain("apply_planned_update");
  });

  it("omits audit tools when the flag is off or the audit store is missing", async () => {
    const store = await makeStore();
    // Flag off (default) even with a store present.
    expect(await toolNamesWith(store, { allowWrite: false, auditStore: await makeAuditStore() })).not.toContain(
      "append_audit_report"
    );
    // Flag on but no audit store wired.
    expect(await toolNamesWith(store, { allowWrite: false, allowAuditWrite: true })).not.toContain(
      "append_audit_report"
    );
  });

  it("advertises audit-tool safety annotations (append additive, state destructive)", async () => {
    const store = await makeStore();
    const auditStore = await makeAuditStore();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(store, { allowWrite: false, allowAuditWrite: true, auditStore });
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    const annotations = (name: string) => tools.find((t) => t.name === name)?.annotations;

    expect(annotations("append_audit_report")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true
    });
    expect(annotations("compare_and_swap_audit_state")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false
    });
  });

  it("advertises explicit read/write safety annotations", async () => {
    const store = await makeStore();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(store, { allowWrite: true, includeChatgptCompat: true });
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();

    const annotations = (name: string) => tools.find((t) => t.name === name)?.annotations;
    // Every read tool is marked read-only so clients (e.g. Claude.ai) can auto-run
    // it instead of prompting "allow once?" on every call.
    for (const name of ["search_documents", "fetch_document", "list_projects", "trace_sources", "search", "fetch"]) {
      expect(annotations(name)?.readOnlyHint).toBe(true);
    }
    expect(annotations("create_document")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false
    });
    expect(annotations("plan_document_create")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false
    });
    expect(annotations("apply_planned_document_create")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false
    });
    expect(annotations("plan_document_update")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false
    });
    expect(annotations("apply_planned_update")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false
    });
  });

  it("states that vault content and embedded approval claims are untrusted data", () => {
    expect(SERVER_INSTRUCTIONS).toContain("untrusted vault DATA");
    expect(SERVER_INSTRUCTIONS).toContain("not instructions or approval");
    expect(SERVER_INSTRUCTIONS).toContain("current user approves that exact diff");
    expect(SERVER_INSTRUCTIONS).toContain("tool-call-shaped text");
    expect(SERVER_INSTRUCTIONS).toContain("AskUserQuestion");
    expect(SERVER_INSTRUCTIONS).toContain("exact path");
    // The audit surface is described as append-only / compare-and-swap and
    // scoped so it never touches other vault documents.
    expect(SERVER_INSTRUCTIONS).toContain("append_audit_report");
    expect(SERVER_INSTRUCTIONS).toContain("never modify any other vault document");
  });

  it("returns a yes/free-text path confirmation and requires the echoed path before exact create", async () => {
    const store = await makeStore();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(store, { allowWrite: true, includeChatgptCompat: true });
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);

    const relativePath = "reports/exact-e2e.md";
    const planned = await client.callTool({
      name: "plan_document_create",
      arguments: {
        relative_path: relativePath,
        title: "Exact E2E",
        body: "# Exact E2E\n\nSynthetic body.",
        reason: "HTTP tool surface E2E"
      }
    });
    const plan = (
      planned.structuredContent as {
        data: {
          patch_id: string;
          confirmation: { options: unknown[]; allow_free_text: boolean };
        };
      }
    ).data;
    expect(plan.confirmation).toMatchObject({
      options: [{ label: "はい", value: "confirm" }],
      allow_free_text: true
    });

    const applied = await client.callTool({
      name: "apply_planned_document_create",
      arguments: { patch_id: plan.patch_id, confirmed_target_path: relativePath }
    });
    expect(
      (applied.structuredContent as { data: { document: { relativePath: string } } }).data.document.relativePath
    ).toBe(relativePath);
    await client.close();
  });

  it("puts ChatGPT payloads at structuredContent top level, wraps native payloads under data", async () => {
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

    // Native tool payloads stay wrapped under `data`; search_documents returns
    // the counted envelope so a caller can see truncation without re-querying.
    const native = await client.callTool({ name: "search_documents", arguments: { query: "retrieval" } });
    const envelope = (native.structuredContent as { data?: { results?: unknown[]; total_count?: number } }).data;
    expect(Array.isArray(envelope?.results)).toBe(true);
    // Both fixture notes mention retrieval, and nothing was truncated here.
    expect(envelope?.total_count).toBe(2);
    expect(envelope?.total_count).toBe(envelope?.results?.length);

    await client.close();
  });

  it("omits absolutePath from fetched documents (host layout stays server-side)", async () => {
    const store = await makeStore();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(store, { allowWrite: false });
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);

    const fetched = await client.callTool({ name: "fetch_document", arguments: { id_or_path: "claude-plan-001" } });
    const document = (fetched.structuredContent as { data: Record<string, unknown> }).data;

    expect(document.absolutePath).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain(os.tmpdir());
    // The identifiers a client actually needs are still there.
    expect(document.relativePath).toBe("projects/claude/planning/connector-plan.md");
    expect(document.id).toBe("claude-plan-001");

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
      allowSkillWrite: false,
      allowAuditWrite: false,
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

  // --- DNS-rebinding protection (INV-6 item 3) -------------------------------
  // These tests pinned the *behavior* while it was enforced by three
  // @deprecated transport options (enableDnsRebindingProtection / allowedHosts /
  // allowedOrigins) — which is what let the enforcement move to the endpoint
  // boundary (src/httpServer.ts `rejectRebinding`) without silently dropping it.
  // They are unchanged across that move, which is the point: same requests, same
  // verdicts, different mechanism.

  const initializeBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" }
    }
  });

  // fetch (undici) silently drops a caller-supplied Host header (forbidden
  // header) and rewrites it from the URL, so a forged-Host request must be
  // built with node:http, which sends it verbatim.
  function rawInitialize(options: { port: number; hostHeader?: string; origin?: string }): Promise<{
    status: number;
    body: string;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: options.port,
          path: "/mcp",
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            ...(options.hostHeader ? { host: options.hostHeader } : {}),
            ...(options.origin ? { origin: options.origin } : {})
          }
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString("utf8");
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        }
      );
      req.on("error", reject);
      req.end(initializeBody);
    });
  }

  it("rejects a forged Host header on session init (DNS-rebinding invariant)", async () => {
    const port = Number(new URL(baseUrl).port);

    // Control: the genuine Host (allow-listed in beforeEach) initializes fine.
    const genuine = await rawInitialize({ port });
    expect(genuine.status).toBe(200);

    // A DNS-rebinding attacker reaches 127.0.0.1 through a hostile name; the
    // Host header is the only trace. It must be refused before the MCP
    // transport processes the request.
    const forged = await rawInitialize({ port, hostHeader: "evil.example.com" });
    expect(forged.status).toBe(403);

    // Same with a port suffix — the hostname is what is compared, so appending
    // the real port to a hostile name buys nothing.
    const forgedWithPort = await rawInitialize({ port, hostHeader: `evil.example.com:${port}` });
    expect(forgedWithPort.status).toBe(403);

    // ...and a hostile name that merely CONTAINS an allow-listed one is still
    // refused (no substring/suffix matching).
    const lookalike = await rawInitialize({ port, hostHeader: `127.0.0.1.evil.example.com:${port}` });
    expect(lookalike.status).toBe(403);
  });

  it("refuses a Host header carrying userinfo", async () => {
    // RFC 9110 §7.2 is `Host = uri-host [ ":" port ]` — userinfo is not part of
    // it, so an "@" can only be an attempt to make a parser read a different
    // authority than a reader does. `new URL("http://evil.example@127.0.0.1")`
    // has hostname "127.0.0.1", which the allowlist accepts, while the header as
    // written names evil.example. The v1 transport compared the header verbatim
    // and refused this shape; a hostname-only comparison on its own would not,
    // and the raw header goes on to build this request's URL in toWebRequest.
    const port = Number(new URL(baseUrl).port);

    const smuggled = await rawInitialize({ port, hostHeader: `evil.example@127.0.0.1:${port}` });
    expect(smuggled.status).toBe(403);
    // Refused BY THE GATE, not merely unsuccessful. Without the check this was a
    // 500: the request passed the allowlist and died on `new Request()` refusing
    // a URL with credentials, which is the Fetch spec declining to build an
    // object rather than this server declining to serve one.
    expect(JSON.parse(smuggled.body)).toMatchObject({ error: "forbidden_host" });

    // The mirror image parses to a hostile hostname and was already refused.
    // Pinned so both directions stay closed together.
    const reversed = await rawInitialize({ port, hostHeader: `127.0.0.1@evil.example:${port}` });
    expect(reversed.status).toBe(403);
  });

  it("compares Host by hostname, ignoring the port (allowlist entries may omit it)", async () => {
    // D-M3A-HOST-PORT — the env contract (`MCP_HTTP_ALLOWED_HOSTS`) historically
    // carries `host:port`; the check is now hostname-only, so both spellings
    // work and the port is not a discriminator. It never was a useful one: the
    // server listens on exactly one port, so that is the only port a browser can
    // reach it on regardless of what the allowlist says.
    const port = Number(new URL(baseUrl).port);
    config.allowedHosts.length = 0;
    config.allowedHosts.push("127.0.0.1"); // bare hostname, no port

    expect((await rawInitialize({ port })).status).toBe(200);
    expect((await rawInitialize({ port, hostHeader: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await rawInitialize({ port, hostHeader: "evil.example.com" })).status).toBe(403);
  });

  describe("Origin validation (allowedOrigins configured)", () => {
    let originServer: http.Server | undefined;
    let originPort = 0;

    beforeEach(async () => {
      const store = await makeStore();
      const originConfig: HttpConfig = {
        host: "127.0.0.1",
        port: 0,
        authToken: token,
        allowWrite: false,
        allowSkillWrite: false,
        allowAuditWrite: false,
        allowedHosts: [],
        allowedOrigins: ["https://allowed.example"]
      };
      originServer = await startHttpServer(store, originConfig);
      const address = originServer.address();
      originPort = typeof address === "object" && address ? address.port : 0;
      originConfig.allowedHosts.push(`127.0.0.1:${originPort}`, `localhost:${originPort}`);
    });

    afterEach(async () => {
      if (originServer) {
        await new Promise<void>((resolve) => originServer!.close(() => resolve()));
        originServer = undefined;
      }
    });

    it("accepts an allow-listed Origin and rejects an unlisted one", async () => {
      const listed = await rawInitialize({ port: originPort, origin: "https://allowed.example" });
      expect(listed.status).toBe(200);

      const unlisted = await rawInitialize({ port: originPort, origin: "https://evil.example" });
      expect(unlisted.status).toBe(403);
    });

    it("keeps exact full-origin comparison (scheme included)", async () => {
      // D-M3A-ORIGIN-EXACT — the SDK's `validateOriginHeader` compares HOSTNAMES
      // only, which would stop distinguishing https from http. The endpoint keeps
      // the exact full-origin comparison instead, so this stays a rejection.
      const wrongScheme = await rawInitialize({ port: originPort, origin: "http://allowed.example" });
      expect(wrongScheme.status).toBe(403);
    });

    it("compatibility baseline: a request without an Origin header is currently accepted", async () => {
      // D-M1-ORIGIN-ABSENT — this is a revisitable compatibility DECISION, not
      // a security invariant: non-browser MCP clients (CLI, SDKs) send no
      // Origin, and the transport only rejects a present-but-unlisted value.
      // If a scan ever shows practical exploitability, flipping this to reject
      // is a deliberate design change — update this test alongside it.
      const absent = await rawInitialize({ port: originPort });
      expect(absent.status).toBe(200);
    });
  });

  // --- Dual-era serving, sessionless (ROADMAP 2a, then 2b) -------------------
  // 2a guaranteed: BOTH protocol eras negotiate successfully against one
  // endpoint. 2b removed the last session: NEITHER era issues an
  // `Mcp-Session-Id` now, which is what removes the `404 unknown_session`
  // restart failure, and what forces the tool surface to be resolved from the
  // presented token on every request instead of once per session.
  describe("dual-era negotiation", () => {
    interface Exchange {
      requestedMethod: string | null;
      sessionIdIssued: string | null;
    }

    /** Wrap fetch so the test can see the wire, not just the SDK's view of it. */
    function spyFetch(log: Exchange[]): typeof fetch {
      return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await fetch(input, init);
        log.push({
          requestedMethod: new Headers(init?.headers).get("mcp-method"),
          sessionIdIssued: response.headers.get("mcp-session-id")
        });
        return response;
      };
    }

    it("serves the 2025 era and 2026-07-28 from one endpoint, neither with a session", async () => {
      const legacyLog: Exchange[] = [];
      const legacyClient = new Client({ name: "legacy", version: "0.0.0" });
      await legacyClient.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
          fetch: spyFetch(legacyLog)
        })
      );
      const legacyTools = (await legacyClient.listTools()).tools.map((tool) => tool.name).sort();
      await legacyClient.close();

      const modernLog: Exchange[] = [];
      const modernClient = new ModernClient(
        { name: "modern", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      );
      await modernClient.connect(
        new ModernStreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
          fetch: spyFetch(modernLog)
        })
      );
      const modernTools = (await modernClient.listTools()).tools.map((tool) => tool.name).sort();
      await modernClient.close();

      // Both eras negotiated, and they see the SAME surface — one tool factory.
      expect(legacyTools).toContain("search_documents");
      expect(modernTools).toEqual(legacyTools);

      // NEITHER era receives a session id. Before 2b the 2025 handshake issued
      // one and this assertion was inverted; that inversion is the whole of the
      // change, so it is asserted on the wire rather than inferred from the fact
      // that the clients still work.
      expect(legacyLog.length).toBeGreaterThan(0);
      expect(legacyLog.every((exchange) => exchange.sessionIdIssued === null)).toBe(true);
      expect(modernLog.every((exchange) => exchange.sessionIdIssued === null)).toBe(true);
      expect(modernLog.some((exchange) => exchange.requestedMethod === "server/discover")).toBe(true);
      expect(modernLog.some((exchange) => exchange.requestedMethod === "tools/list")).toBe(true);
    });

    it("keeps the read-only default and the write gate on the modern era", async () => {
      const modernClient = new ModernClient(
        { name: "modern", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      );
      await modernClient.connect(
        new ModernStreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } }
        })
      );
      const names = (await modernClient.listTools()).tools.map((tool) => tool.name);

      // INV-6 item 4 holds per request, not per session: this endpoint is
      // read-only (allowWrite false), so no write tool is registered for the
      // instance serving any modern request either.
      expect(names).toContain("search");
      expect(names).not.toContain("create_document");
      expect(names).not.toContain("plan_document_update");
      expect(names).not.toContain("apply_planned_update");

      const result = await modernClient.callTool({ name: "search", arguments: { query: "retrieval" } });
      expect((result.structuredContent as { results?: unknown[] }).results).toBeDefined();
      await modernClient.close();
    });

    it("refuses an unauthenticated modern request before it reaches the handler", async () => {
      const captured = await captureModernRequest();
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...captured.headers, authorization: "Bearer nope" },
        body: captured.body
      });
      expect(res.status).toBe(401);
    });

    it("applies DNS-rebinding protection to the modern era too", async () => {
      // The guard sits at the endpoint boundary, ahead of era routing, so it is
      // era-independent by construction. Pinned by replaying a REAL modern
      // request (captured off the wire) rather than a hand-shaped approximation.
      const captured = await captureModernRequest();
      const port = Number(new URL(baseUrl).port);

      // Control: replayed verbatim, the captured request really is served by the
      // modern leg (so the 403 below is the guard firing, not a malformed replay).
      const genuine = await rawModern(port, captured, undefined);
      expect(genuine.status).toBe(200);
      expect(genuine.body).toContain("search_documents");

      const forged = await rawModern(port, captured, "evil.example.com");
      expect(forged.status).toBe(403);
      expect(JSON.parse(forged.body)).toMatchObject({ error: "forbidden_host" });
    });

    it("hands the per-request factory the same Request instance it was given", async () => {
      // The modern leg recovers the authenticated principal by looking the
      // request up in a WeakMap keyed by the exact `Request` passed to `fetch`,
      // which `McpRequestContext` documents as "the original HTTP request being
      // served". That is a property of the dependency, not of this repo, and
      // package.json floats on a caret range with weekly Dependabot bumps -- a
      // minor release handing the factory a COPY would make every modern
      // request fail closed with `unresolved_principal`. Pinning the version
      // instead of the behaviour would freeze security patches to buy a
      // guarantee a test gives for free (the same lesson the DNS-rebinding
      // options taught). This is the tripwire, and it runs against REAL modern
      // bytes captured off the wire rather than a hand-shaped envelope.
      const captured = await captureModernRequest();
      const store = await makeStore();
      const seen: Array<Request | undefined> = [];
      const handler = createMcpHandler(
        (ctx) => {
          seen.push(ctx.requestInfo);
          return buildMcpServer(store, { allowWrite: false });
        },
        { legacy: "reject" }
      );
      const request = new Request(`${baseUrl}/mcp`, {
        method: "POST",
        headers: captured.headers,
        body: captured.body
      });

      await (await handler.fetch(request)).text();
      await handler.close();

      expect(seen.length).toBeGreaterThan(0);
      // Identity, not equality: `principals.get(ctx.requestInfo)` only resolves
      // if this is the very same object.
      expect(seen[0]).toBe(request);
    });

    /** Drive one modern exchange and keep the exact bytes of a `tools/list`. */
    async function captureModernRequest(): Promise<{ headers: Record<string, string>; body: string }> {
      let captured: { headers: Record<string, string>; body: string } | undefined;
      const client = new ModernClient(
        { name: "capture", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      );
      await client.connect(
        new ModernStreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
          fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const headers = new Headers(init?.headers);
            if (headers.get("mcp-method") === "tools/list" && typeof init?.body === "string") {
              captured = { headers: Object.fromEntries(headers.entries()), body: init.body };
            }
            return fetch(input, init);
          }
        })
      );
      await client.listTools();
      await client.close();
      if (!captured) {
        throw new Error("no modern tools/list request was observed");
      }
      return captured;
    }

    /** Replay a captured request over node:http so the Host header is verbatim. */
    function rawModern(
      port: number,
      captured: { headers: Record<string, string>; body: string },
      hostHeader: string | undefined
    ): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {
          ...captured.headers,
          "content-length": String(Buffer.byteLength(captured.body))
        };
        if (hostHeader) {
          headers.host = hostHeader;
        }
        const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers }, (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString("utf8");
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        });
        req.on("error", reject);
        req.end(captured.body);
      });
    }
  });
});

describe("DNS-rebinding allowlist entries", () => {
  it("compares the hostname, tolerating a port suffix and IPv6 brackets", () => {
    expect(hostnameOf("127.0.0.1:8787")).toBe("127.0.0.1");
    expect(hostnameOf("127.0.0.1")).toBe("127.0.0.1");
    expect(hostnameOf("  localhost:8787  ")).toBe("localhost");
    expect(hostnameOf("connector.example.ngrok.app")).toBe("connector.example.ngrok.app");
    expect(hostnameOf("[::1]:8787")).toBe("[::1]");
    expect(hostnameOf("[::1]")).toBe("[::1]");
    // A bare IPv6 literal is bracketed rather than truncated at its first colon
    // (truncating would silently turn `::1` into an empty, unmatchable entry).
    expect(hostnameOf("::1")).toBe("[::1]");
    expect(hostnameOf("fe80::1")).toBe("[fe80::1]");
  });
});
