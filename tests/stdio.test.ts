import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS } from "../src/server.js";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(repoRoot, "src", "index.ts");
const tsxLoader = pathToFileURL(path.join(repoRoot, "node_modules", "tsx", "dist", "esm", "index.mjs")).href;

/**
 * Dual-era **stdio** (ROADMAP 2c), driven end-to-end against the real
 * entrypoint: each client spawns `src/index.ts` exactly the way an MCP client
 * registration does, so what is pinned here is the shipped wiring rather than a
 * re-created copy of it in the test.
 *
 * Real client implementations on both legs, deliberately: a hand-shaped
 * 2026-07-28 opening tests our understanding of the protocol rather than the
 * protocol (see D-M3A-REQUESTINFO in the project state — the first version of
 * the HTTP dependency-contract test never reached the factory at all).
 */
describe("stdio dual-era serving", () => {
  let vault: string;
  let stateDir: string;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-stdio-vault-"));
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-stdio-state-"));
    await fs.cp(path.join(repoRoot, "fixtures", "synthetic-vault"), vault, { recursive: true });
  });

  afterEach(async () => {
    for (const dir of [vault, stateDir]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  /** The env an MCP client registration supplies: roots and paths, nothing else. */
  function serverEnv(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      KNOWLEDGE_ROOT: vault,
      MCP_PATCH_STATE_DIR: path.join(stateDir, "patches")
    };
  }

  const spawnArgs = { command: process.execPath, args: ["--import", tsxLoader, entry] };

  it("serves the 2025 era and 2026-07-28 from one factory, with the same tool surface", async () => {
    // 2025 era: a real v1 client, which negotiates the `initialize` handshake.
    // This leg is what `legacy: "serve"` buys — flipping it to "reject" in
    // src/index.ts makes this connect() fail.
    const legacyClient = new Client({ name: "legacy", version: "0.0.0" });
    await legacyClient.connect(new StdioClientTransport({ ...spawnArgs, env: serverEnv() }));
    const legacyTools = (await legacyClient.listTools()).tools.map((tool) => tool.name).sort();
    const legacyInstructions = legacyClient.getInstructions();
    await legacyClient.close();

    // 2026-07-28: a real v2 client pinned to the modern revision (the v2 default
    // is `legacy`, so without the pin this would negotiate the 2025 era again
    // and the test would silently check one era twice).
    const modernClient = new ModernClient(
      { name: "modern", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await modernClient.connect(new ModernStdioClientTransport({ ...spawnArgs, env: serverEnv() }));
    const modernTools = (await modernClient.listTools()).tools.map((tool) => tool.name).sort();
    const modernInstructions = modernClient.getInstructions();
    await modernClient.close();

    // One factory serves both eras, so the surface cannot drift between them.
    expect(legacyTools).toContain("search_documents");
    expect(modernTools).toEqual(legacyTools);

    // stdio stays the full local surface — the HTTP read-only default is an
    // HTTP-transport property (INV-6), and moving to serveStdio must not have
    // quietly imported it here.
    expect(legacyTools).toEqual(
      expect.arrayContaining(["create_document", "plan_document_update", "apply_planned_update"])
    );

    // INV-5: the untrusted-vault-data boundary text reaches BOTH eras. Asserted
    // on the wire rather than on the constant, because the failure mode worth
    // catching is an era that never receives it.
    expect(legacyInstructions).toBe(SERVER_INSTRUCTIONS);
    expect(modernInstructions).toBe(SERVER_INSTRUCTIONS);
  }, 60_000);

  it("serves a real tool call on the modern era, not just discovery", async () => {
    const client = new ModernClient(
      { name: "modern-call", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await client.connect(new ModernStdioClientTransport({ ...spawnArgs, env: serverEnv() }));

    // A negotiated handshake that cannot actually answer a request would still
    // pass a discovery-only assertion.
    const result = await client.callTool({ name: "search_documents", arguments: { query: "retrieval" } });
    // `jsonResult` wraps every non-ChatGPT tool as `structuredContent.data`;
    // only the frozen `search`/`fetch` aliases hoist their payload to the top.
    const data = (result.structuredContent as { data?: { results?: unknown[]; total_count?: number } }).data;
    expect(Array.isArray(data?.results)).toBe(true);
    expect(data?.total_count).toBeGreaterThan(0);
    await client.close();
  }, 60_000);
});
