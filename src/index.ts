#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, loadEnvFile, loadHttpConfig, selectedTransport } from "./config.js";
import { startHttpServer } from "./httpServer.js";
import { AuditStore } from "./auditStore.js";
import { createStore } from "./multiRootStore.js";
import { buildMcpServer } from "./server.js";
import { SkillStore } from "./skillStore.js";

// Optional env file, read ONCE here at startup and ONLY from the absolute path
// in MCP_ENV_FILE — never from the process working directory, which a local
// stdio client picks for us and an untrusted repo could therefore control.
loadEnvFile();

// Single KNOWLEDGE_ROOT -> plain KnowledgeStore (unchanged behavior).
// KNOWLEDGE_ROOTS -> multi-root composite: first root writable, rest read-only.
const appConfig = loadConfig();
const store = createStore(appConfig);
await store.init();
const skillStore = appConfig.skillsSubdir
  ? new SkillStore({
      knowledgeRoot: appConfig.knowledgeRoots[0].path,
      skillsSubdir: appConfig.skillsSubdir,
      patchStateDir: appConfig.patchStateDir
    })
  : undefined;
await skillStore?.init();
// Constrained audit write surface (append + CAS) scoped to MCP_AUDIT_SUBDIR.
// Independent of general/Skill writes; used by an unattended scanner endpoint.
const auditStore = appConfig.auditSubdir
  ? new AuditStore({
      knowledgeRoot: appConfig.knowledgeRoots[0].path,
      auditSubdir: appConfig.auditSubdir
    })
  : undefined;
await auditStore?.init();

const transport = selectedTransport();

if (transport === "http") {
  // Remote Streamable HTTP endpoint for Chat connectors (ChatGPT / Claude.ai).
  // Read-only by default; bearer-authenticated; binds to 127.0.0.1.
  const httpConfig = loadHttpConfig();
  const httpServer = await startHttpServer(store, httpConfig, skillStore, auditStore);
  const address = httpServer.address();
  const where =
    typeof address === "object" && address
      ? `${address.address}:${address.port}`
      : `${httpConfig.host}:${httpConfig.port}`;
  // `skills` and `audit` report THREE states, the same ones the stdio branch
  // below prints and for the same reason: reserving a subtree and registering
  // the tools that write into it are separate decisions, so one on/off word can
  // only ever name one of them.
  //
  //   off            no MCP_SKILLS_SUBDIR / MCP_AUDIT_SUBDIR — the INV-8 / INV-9
  //                  reservation is NOT in effect for this process
  //   reserved-only  subtree reserved, the write tools are not registered
  //   on             reserved AND registered (MCP_HTTP_ALLOW_{SKILL,AUDIT}_WRITE)
  //
  // These two printed the flag alone until now, which is exactly the mistake the
  // `legacy_create` comment below already names — echoing the environment back
  // instead of describing the surface. It cost more here than a confusing word.
  // `audit=off` meant "tools not registered" on HTTP and "subtree NOT reserved"
  // on stdio: one token, opposite readings, on the two processes an operator is
  // told to compare. INV-9 holds only if EVERY write-capable process against a
  // vault reserves the same subtree, and the HTTP line was silent about the one
  // half that condition is about, on the transport that is remotely reachable.
  // Confirming it took reading loadHttpConfig; it is one word now.
  const httpSkillsState = !skillStore ? "off" : httpConfig.allowSkillWrite ? "on" : "reserved-only";
  const httpAuditState = !auditStore ? "off" : httpConfig.allowAuditWrite ? "on" : "reserved-only";
  // stderr only — stdout is reserved for protocol data on stdio, and we keep
  // logs free of the auth token or any vault content.
  process.stderr.write(
    `MCP HTTP transport listening on http://${where}/mcp ` +
      `(write=${httpConfig.allowWrite || httpConfig.allowSkillWrite || httpConfig.allowAuditWrite ? "on" : "off"}, ` +
      `documents=${httpConfig.allowWrite ? "on" : "off"}, ` +
      // Both flags, because both are required to register the tool. Reporting
      // the variable alone would print `documents=off, legacy_create=on` for an
      // endpoint that exposes no create_document at all — a startup line exists
      // to describe the surface, not to echo the environment back.
      `legacy_create=${httpConfig.allowWrite && httpConfig.allowLegacyCreateDocument ? "on" : "off"}, ` +
      `skills=${httpSkillsState}, ` +
      `audit=${httpAuditState}, ` +
      `oauth=${httpConfig.oauth ? "on" : "off"})\n`
  );
} else {
  // Local stdio transport for CLI clients (Claude Code, Codex, Claude Desktop).
  // serveStdio owns the era decision for this connection: the opening exchange
  // selects 2025 or 2026-07-28, and ONE instance from this factory is pinned for
  // the connection's lifetime. The same factory serves both eras, so the tool
  // surface cannot drift between them.
  //
  // Pinning one instance per connection is what 2b deliberately removed from
  // HTTP, and it is safe *here* for a reason that does not hold there: on HTTP
  // successive requests on one connection can present different bearer tokens,
  // so the surface has to be re-derived per request from the presented
  // principal. stdio carries no principal at all — serveStdio never populates
  // `ctx.authInfo`/`ctx.requestInfo`, the peer is the process that spawned us,
  // and the surface below is a constant. Pinned and per-request are therefore
  // observationally identical on stdio. Do not "fix" this for symmetry with
  // HTTP, and do not reintroduce pinning on HTTP by analogy with this.
  serveStdio(
    () =>
      buildMcpServer(store, {
        allowWrite: true,
        // Off unless MCP_ALLOW_LEGACY_CREATE_DOCUMENT is set, even though stdio
        // is otherwise the full surface. "Local client" is not the same as
        // "approved by the user": this process reads untrusted vault content
        // (INV-5) and create_document is the one write that acts on a single
        // call, so leaving it on by default would keep the server's approval
        // claim resting on the model rather than on the plan/apply mechanism.
        allowLegacyCreateDocument: appConfig.allowLegacyCreateDocument,
        // Same split as the audit tools below, and it was missing here: this
        // used to be `Boolean(skillStore)`, so setting MCP_SKILLS_SUBDIR to get
        // the INV-8 reservation also registered the Skill write tools on every
        // interactive stdio session. The reservation rides on
        // `config.skillsSubdir` through `createStore`, so withholding the tools
        // leaves it fully in force.
        allowSkillWrite: appConfig.stdioAllowSkillWrite,
        skillStore,
        // Registering the audit write tools is a SEPARATE decision from
        // reserving the subtree (INV-9); see AppConfig.stdioAllowAuditWrite for
        // why conflating them was a hole. The reservation itself rides on
        // config.auditSubdir through createStore and is unaffected by this flag,
        // so an operator who sets only MCP_AUDIT_SUBDIR still gets the
        // protection they were told to set it for — without also handing this
        // session two unconfirmed, single-call writes into the audit trail.
        allowAuditWrite: appConfig.stdioAllowAuditWrite && Boolean(auditStore),
        auditStore,
        includeChatgptCompat: true
      }),
    {
      // Explicit rather than defaulted: dual-era stdio is the point of this
      // wiring, so a future change of the library default must not silently
      // turn 2025-era clients away. Pinned by tests/stdio.test.ts.
      legacy: "serve",
      // serveStdio starts the wire in the background and drops the rejection
      // when no handler is installed (`started.catch(() => {})`), so without
      // this a transport that failed to start would leave the "ready" line
      // below as the only output and look healthy. Non-fatal by design —
      // malformed input from the client must not be able to kill the server.
      //
      // NEVER the message. This callback also receives runtime out-of-band
      // errors, and those messages can quote inbound bytes — vault content and
      // client input are untrusted (INV-5), and stderr goes to a client-owned
      // debug log. `code` is exempt from that rule and is the reason this line
      // is worth printing at all: Node's system errors carry the whole signal
      // there (`EACCES`, `ENOTCONN`) while `name` flattens every one of them to
      // "Error". It is a fixed token from the runtime, never client-supplied
      // content, so it says what failed without echoing anything.
      onerror: (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        process.stderr.write(`MCP stdio transport error: ${error.name}${code ? ` (${code})` : ""}\n`);
      }
    }
  );
  // stderr only — stdout is the JSON-RPC channel on stdio. Names the effective
  // write surface the way the HTTP branch above does, so an unset
  // MCP_AUDIT_SUBDIR (which leaves this write-capable process with the INV-9
  // audit-subtree reservation OFF) is visible instead of silent.
  //
  // `audit` reports THREE states, because reserving the subtree and registering
  // the write tools are now separate decisions and a single on/off could only
  // ever describe one of them:
  //
  //   off            no MCP_AUDIT_SUBDIR — the INV-9 reservation is NOT in effect
  //   reserved-only  subtree reserved, audit write tools not registered (default)
  //   on             reserved AND the write tools registered
  //                  (MCP_STDIO_ALLOW_AUDIT_WRITE)
  //
  // The middle state is the one worth printing: it is what an operator who
  // followed the "set MCP_AUDIT_SUBDIR on every write-capable process" guidance
  // now gets, and reading "off" there would wrongly suggest the reservation
  // lapsed.
  //
  // This now precedes the wire being up, where it used to follow
  // `await server.connect(...)`. `serveStdio` starts in the background and
  // hands back only `close()`, so there is no started promise to await — the
  // line states the surface this process WILL serve, not that the transport
  // came up. A failure therefore reads "ready" and then the `onerror` line
  // above; that line, not this one, is the one to trust about start-up.
  //
  // `skills` reports the same three states for the same reason. It used to be a
  // plain on/off derived from whether the subtree existed, which named the
  // reservation and the tool surface with one word while they were already
  // capable of disagreeing.
  const auditState = !auditStore ? "off" : appConfig.stdioAllowAuditWrite ? "on" : "reserved-only";
  const skillsState = !skillStore ? "off" : appConfig.stdioAllowSkillWrite ? "on" : "reserved-only";
  process.stderr.write(
    `MCP stdio transport ready (write=on, documents=on, ` +
      `legacy_create=${appConfig.allowLegacyCreateDocument ? "on" : "off"}, ` +
      `skills=${skillsState}, audit=${auditState})\n`
  );
}
