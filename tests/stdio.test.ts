import { spawn } from "node:child_process";
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
   * The operator-file registration. Both write flags are off by default on
   * purpose: that is what setting MCP_AUDIT_SUBDIR / MCP_SKILLS_SUBDIR alone now
   * produces — the INV-9 and INV-8 reservations in effect, neither write surface
   * registered. Pass them to get the full surface.
   */
  async function operatorEnv(
    options: { auditWrite?: boolean; skillWrite?: boolean } = {}
  ): Promise<Record<string, string>> {
    await fs.mkdir(path.join(vault, "_skills"), { recursive: true });
    await fs.mkdir(path.join(vault, "90_Audit", "vault-scan", "reports"), { recursive: true });
    const suffix = `${options.auditWrite ? "-auditwrite" : ""}${options.skillWrite ? "-skillwrite" : ""}`;
    const envFile = path.join(stateDir, `vault${suffix}.env`);
    await fs.writeFile(
      envFile,
      [
        "MCP_SKILLS_SUBDIR=_skills",
        "MCP_AUDIT_SUBDIR=90_Audit/vault-scan",
        `MCP_PATCH_STATE_DIR=${path.join(stateDir, "patches")}`,
        ...(options.auditWrite ? ["MCP_STDIO_ALLOW_AUDIT_WRITE=1"] : []),
        ...(options.skillWrite ? ["MCP_STDIO_ALLOW_SKILL_WRITE=1"] : []),
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
    const env = await operatorEnv({ auditWrite: true, skillWrite: true });

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

  it("withholds BOTH write surfaces from a session that only reserved the subtrees", async () => {
    // MCP_AUDIT_SUBDIR / MCP_SKILLS_SUBDIR are what operators are told to set on
    // EVERY write-capable process, so the INV-9 and INV-8 reservations hold
    // everywhere. Setting them used to also hand the session the tools that
    // write into those subtrees, on a transport whose input is untrusted vault
    // content (INV-5) — so following the documented guidance armed the very
    // surfaces the reservations exist to protect.
    //
    // The audit half was split first. The Skill half kept the old shape for
    // long enough that this test asserted it POSITIVELY, one line below the
    // audit assertions, describing the asymmetry as if it were a scope decision:
    // "the Skill surface ... is untouched". It was the same hole, unfixed.
    //
    // Skill creation is two-step, so this was never the single-call exposure the
    // audit pair had. That does not make it lighter: a Skill is loaded by later
    // sessions AS INSTRUCTIONS, which is the premise INV-8 exists for.
    //
    // The next two tests drive this same env and show both reservations still
    // refuse a general write, so this is withholding tools, not disabling
    // protection. (Only the audit one existed when this comment was first
    // written — the Skill one was added after an external review caught the
    // claim being false.)
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
    expect(tools).not.toContain("plan_skill_create");
    expect(tools).not.toContain("apply_planned_skill_create");
    // Not a blanket withdrawal: the general document write surface, which these
    // flags say nothing about, is still there. Without this the test would also
    // pass if stdio had stopped registering writes altogether.
    expect(tools).toEqual(expect.arrayContaining(["plan_document_update", "apply_planned_update"]));
  }, 60_000);

  it("registers each write surface only when its own flag is set", async () => {
    // The two flags are independent. Enabling Skills must not drag in the audit
    // pair, or "separate decisions" would be true of the config and false of the
    // surface it produces.
    const env = await operatorEnv({ skillWrite: true });
    const client = new ModernClient(
      { name: "modern-skill-only", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await client.connect(new ModernStdioClientTransport({ ...spawnArgs, env }));
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    await client.close();

    expect(tools).toEqual(expect.arrayContaining(["plan_skill_create", "apply_planned_skill_create"]));
    expect(tools).not.toContain("append_audit_report");
    expect(tools).not.toContain("compare_and_swap_audit_state");
  }, 60_000);

  it("refuses a general document write into the reserved Skill subtree, on the wire", async () => {
    // The INV-8 counterpart of the INV-9 test below, and it did not exist. The
    // withhold test above claimed it did — "the next two tests ... show both
    // reservations still refuse a general write" — while only the audit one was
    // ever written. A comment is not a test, and this one asserted coverage that
    // would have made its own absence invisible.
    //
    // It matters more now than it did before: withholding the Skill tools by
    // default means the reservation is the ONLY thing standing between a general
    // document write and the Skill subtree on a default stdio session.
    const env = await operatorEnv();
    const client = new ModernClient(
      { name: "modern-skill-reserved", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await client.connect(new ModernStdioClientTransport({ ...spawnArgs, env }));

    const refused = await client.callTool({
      name: "plan_document_create",
      arguments: {
        relative_path: "_skills/forged/SKILL.md",
        title: "forged",
        body: "forged",
        reason: "INV-8 regression probe"
      }
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/reserved/);

    // Same control as the audit case: a write one directory outside still plans,
    // so the refusal is the reservation and not a dead write surface.
    const allowed = await client.callTool({
      name: "plan_document_create",
      arguments: {
        relative_path: "projects/inv8-control.md",
        title: "control",
        body: "control",
        reason: "INV-8 regression probe control"
      }
    });
    expect(allowed.isError).toBeFalsy();

    await client.close();
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

/**
 * GAP-5 — `scripts/check-stdio.mjs`, the declared-vs-live surface check for
 * stdio (HTTP has had one since `check-http.mjs`).
 *
 * Spawned as the operator runs it, against the REAL entrypoint, because the
 * property under test is that the check reads `tools/list` rather than the
 * server's startup line: #113 measured those two disagreeing (restoring the
 * Skill gate turned a wire test red and left the startup-line test green), so a
 * check built on the claim would reproduce the gap it exists to close.
 *
 * The second test is the positive control for the first. "No FAIL line" is only
 * evidence if a FAIL line is reachable — the same reason the audit-surface tests
 * assert what must NOT appear rather than only what must.
 */
describe("scripts/check-stdio.mjs (declared-vs-live stdio surface)", () => {
  let dir: string;
  const script = path.join(repoRoot, "scripts", "check-stdio.mjs");

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-check-stdio-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function runCheck(args: string[]): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => (output += String(chunk)));
      child.stderr.on("data", (chunk) => (output += String(chunk)));
      child.on("close", (code) => resolve({ code, output }));
    });
  }

  it("passes against the real entrypoint and classifies every write category", async () => {
    const vault = path.join(dir, "vault");
    await fs.mkdir(path.join(vault, "90_Audit", "vault-scan", "reports"), { recursive: true });
    await fs.mkdir(path.join(vault, "_skills"), { recursive: true });
    await fs.writeFile(path.join(vault, "note.md"), "---\ntitle: Note\n---\n\nbody\n", "utf8");
    const envFile = path.join(dir, "stdio.env");
    await fs.writeFile(
      envFile,
      [
        `KNOWLEDGE_ROOT=${vault}`,
        `MCP_PATCH_STATE_DIR=${path.join(dir, "patches")}`,
        "MCP_ALLOW_LEGACY_CREATE_DOCUMENT=1",
        "MCP_AUDIT_SUBDIR=90_Audit/vault-scan",
        "MCP_STDIO_ALLOW_AUDIT_WRITE=1",
        // Reserved but NOT registered: the middle state INV-9/INV-8 distinguish,
        // and the one an operator following the "set the subdir everywhere"
        // guidance actually gets.
        "MCP_SKILLS_SUBDIR=_skills",
        ""
      ].join("\n"),
      "utf8"
    );

    const { code, output } = await runCheck(["--env", envFile, "--entry", path.join(repoRoot, "src", "index.ts")]);

    expect(output).toContain("RESULT:");
    expect(output).not.toContain("FAIL:");
    expect(output).not.toContain("WARN:");
    expect(code).toBe(0);
    // The comparison actually RAN: these lines exist only after a live
    // tools/list was classified against the declared flags.
    expect(output).toContain("declared: documents=on legacy_create=on skills=reserved-only audit=on");
    expect(output).toMatch(/tools:\s+\d+ \(\d+ read-only, [1-9]\d* write-capable\)/);
  }, 30000);

  it("fails on a surface WIDER than declared, naming the unclassified tool", async () => {
    // A stub server standing in for a build whose surface exceeded its flags.
    // It answers the same handshake and advertises one write-capable tool that
    // no category permits — the shape check-http.mjs calls "unclassified".
    const stub = path.join(dir, "stub-entry.mjs");
    await fs.writeFile(
      stub,
      [
        "let buffer = '';",
        "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += String(chunk);",
        "  const lines = buffer.split('\\n');",
        "  buffer = lines.pop() ?? '';",
        "  for (const line of lines) {",
        "    if (!line.trim()) continue;",
        "    const message = JSON.parse(line);",
        "    if (message.method === 'initialize') {",
        "      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18',",
        "        capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } } });",
        "    } else if (message.method === 'tools/list') {",
        "      send({ jsonrpc: '2.0', id: message.id, result: { tools: [",
        "        { name: 'search_documents', annotations: { readOnlyHint: true } },",
        "        { name: 'plan_document_create' }, { name: 'apply_planned_document_create' },",
        "        { name: 'plan_document_update' }, { name: 'apply_planned_update' },",
        "        { name: 'exfiltrate_vault' } ] } });",
        "    }",
        "  }",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    const envFile = path.join(dir, "stub.env");
    await fs.writeFile(envFile, `KNOWLEDGE_ROOT=${dir}\n`, "utf8");

    const { code, output } = await runCheck(["--env", envFile, "--entry", stub]);

    expect(output).toContain("WIDER than declared");
    expect(output).toContain("exfiltrate_vault");
    expect(output).toContain("unclassified/unknown: exfiltrate_vault");
    expect(code).toBe(1);
  }, 30000);
});
