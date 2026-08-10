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

  /**
   * The same registration, plus the operator env file that every write-capable
   * stdio process is supposed to carry (docs/operations.md, "INV-9 operating
   * condition"). `KNOWLEDGE_ROOT` stays inline because that is the shape the
   * README registration blocks use, and because the real environment wins over
   * the file (tests/config.test.ts), so the two cannot fight.
   */
  /**
   * The operator-file registration. `auditWrite` is off by default on purpose:
   * that is what setting MCP_AUDIT_SUBDIR alone now produces — the INV-9
   * reservation in effect, the two single-call audit writes NOT registered.
   * Pass it to get the full surface.
   */
  async function operatorEnv(options: { auditWrite?: boolean } = {}): Promise<Record<string, string>> {
    await fs.mkdir(path.join(vault, "_skills"), { recursive: true });
    await fs.mkdir(path.join(vault, "90_Audit", "vault-scan", "reports"), { recursive: true });
    const envFile = path.join(stateDir, options.auditWrite ? "vault-auditwrite.env" : "vault.env");
    await fs.writeFile(
      envFile,
      [
        "MCP_SKILLS_SUBDIR=_skills",
        "MCP_AUDIT_SUBDIR=90_Audit/vault-scan",
        `MCP_PATCH_STATE_DIR=${path.join(stateDir, "patches")}`,
        ...(options.auditWrite ? ["MCP_STDIO_ALLOW_AUDIT_WRITE=1"] : []),
        ""
      ].join("\n"),
      "utf8"
    );
    return {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      KNOWLEDGE_ROOT: vault,
      MCP_ENV_FILE: envFile
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
      expect.arrayContaining(["plan_document_create", "plan_document_update", "apply_planned_update"])
    );

    // ...with one exception, and it is not the HTTP default leaking in: the
    // legacy one-step create is the only document write with no approval gap
    // between the call and the vault changing, so it needs its own opt-in even
    // on the local transport (MCP_ALLOW_LEGACY_CREATE_DOCUMENT, unset here).
    expect(legacyTools).not.toContain("create_document");
    expect(modernTools).not.toContain("create_document");

    // INV-5: the untrusted-vault-data boundary text reaches BOTH eras. Asserted
    // on the wire rather than on the constant, because the failure mode worth
    // catching is an era that never receives it.
    expect(legacyInstructions).toBe(SERVER_INSTRUCTIONS);
    expect(modernInstructions).toBe(SERVER_INSTRUCTIONS);
  }, 60_000);

  // The other half of the gate: with the opt-in set, the legacy route is still
  // reachable for operators who depend on it. Without this the "withholds it"
  // assertion above would also pass if the tool had simply been deleted, which
  // is a different change with a different migration cost.
  it("registers the legacy create_document when its own flag is set", async () => {
    const client = new Client({ name: "legacy-create", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        ...spawnArgs,
        env: { ...serverEnv(), MCP_ALLOW_LEGACY_CREATE_DOCUMENT: "1" }
      })
    );
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    await client.close();

    expect(tools).toContain("create_document");
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

  it("keeps the two eras identical on the FULL surface, not just the audit-off one", async () => {
    const env = await operatorEnv({ auditWrite: true });

    const legacyClient = new Client({ name: "legacy-full", version: "0.0.0" });
    await legacyClient.connect(new StdioClientTransport({ ...spawnArgs, env }));
    const legacyTools = (await legacyClient.listTools()).tools.map((tool) => tool.name).sort();
    await legacyClient.close();

    const modernClient = new ModernClient(
      { name: "modern-full", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await modernClient.connect(new ModernStdioClientTransport({ ...spawnArgs, env }));
    const modernTools = (await modernClient.listTools()).tools.map((tool) => tool.name).sort();
    await modernClient.close();

    // These four exist only when the operator file reached the process. The
    // era-equality assertion above runs solely on the surface a bare
    // registration produces, so an era-conditional branch in buildMcpServer
    // that dropped the audit or Skill tools from one leg would pass unnoticed.
    expect(legacyTools).toEqual(
      expect.arrayContaining([
        "append_audit_report",
        "compare_and_swap_audit_state",
        "plan_skill_create",
        "apply_planned_skill_create"
      ])
    );
    expect(modernTools).toEqual(legacyTools);
  }, 60_000);

  it("withholds the audit write tools from a session that only reserved the subtree", async () => {
    // MCP_AUDIT_SUBDIR is what operators are told to set on EVERY write-capable
    // process, so the INV-9 reservation holds everywhere. It used to also hand
    // the session `append_audit_report` and `compare_and_swap_audit_state` —
    // two single-call writes into the audit trail, with no plan/apply step and
    // no user confirmation, on a transport whose input is untrusted vault
    // content (INV-5). Following the documented guidance therefore armed the
    // one surface the reservation exists to protect.
    //
    // The two are separate decisions now. The very next test drives this same
    // env and shows the reservation still refuses a general write, so this is
    // withholding the tools, not disabling the protection.
    const env = await operatorEnv();
    const client = new ModernClient(
      { name: "modern-reserved-only", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await client.connect(new ModernStdioClientTransport({ ...spawnArgs, env }));
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    await client.close();

    expect(tools).not.toContain("append_audit_report");
    expect(tools).not.toContain("compare_and_swap_audit_state");
    // Scoped to the audit tools: the Skill surface, which the same operator file
    // enables and which is protected by its own plan/apply step, is untouched.
    expect(tools).toEqual(expect.arrayContaining(["plan_skill_create", "apply_planned_skill_create"]));
  }, 60_000);

  it("refuses a general document write into the reserved audit subtree, on the wire", async () => {
    const env = await operatorEnv();
    const client = new ModernClient(
      { name: "modern-reserved", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await client.connect(new ModernStdioClientTransport({ ...spawnArgs, env }));

    // INV-9 end to end. The reservation is a KnowledgeStore predicate and
    // tests/knowledgeStore.test.ts covers the predicate directly, but nothing
    // proved that the always-write-capable stdio surface inherits it. A forged
    // scan report is precisely what an instruction injected into a vault
    // document would aim to write, so this is the assertion that has to hold
    // at the transport such an instruction would arrive on.
    const refused = await client.callTool({
      name: "plan_document_create",
      arguments: {
        relative_path: "90_Audit/vault-scan/reports/forged.md",
        title: "forged",
        body: "forged",
        reason: "INV-9 regression probe"
      }
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/reserved/);

    // Control: the same call one directory outside the reservation still
    // plans, so the refusal above is the reservation and not a dead write
    // surface. Without this the test would pass with writes broken entirely.
    const allowed = await client.callTool({
      name: "plan_document_create",
      arguments: {
        relative_path: "projects/inv9-control.md",
        title: "control",
        body: "control",
        reason: "INV-9 regression probe control"
      }
    });
    expect(allowed.isError).toBeFalsy();

    await client.close();
  }, 60_000);
});
