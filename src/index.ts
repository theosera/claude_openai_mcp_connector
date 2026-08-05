#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
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
  // stderr only — stdout is reserved for protocol data on stdio, and we keep
  // logs free of the auth token or any vault content.
  process.stderr.write(
    `MCP HTTP transport listening on http://${where}/mcp ` +
      `(write=${httpConfig.allowWrite || httpConfig.allowSkillWrite || httpConfig.allowAuditWrite ? "on" : "off"}, ` +
      `documents=${httpConfig.allowWrite ? "on" : "off"}, skills=${httpConfig.allowSkillWrite ? "on" : "off"}, ` +
      `audit=${httpConfig.allowAuditWrite ? "on" : "off"}, ` +
      `oauth=${httpConfig.oauth ? "on" : "off"})\n`
  );
} else {
  // Local stdio transport for CLI clients (Claude Code, Codex, Claude Desktop).
  const server = buildMcpServer(store, {
    allowWrite: true,
    allowSkillWrite: Boolean(skillStore),
    skillStore,
    allowAuditWrite: Boolean(auditStore),
    auditStore,
    includeChatgptCompat: true
  });
  await server.connect(new StdioServerTransport());
  // stderr only — stdout is the JSON-RPC channel on stdio. Names the effective
  // write surface the way the HTTP branch above does, so an unset
  // MCP_AUDIT_SUBDIR (which leaves this write-capable process with the INV-9
  // audit-subtree reservation OFF) is visible instead of silent.
  process.stderr.write(
    `MCP stdio transport ready (write=on, documents=on, ` +
      `skills=${skillStore ? "on" : "off"}, audit=${auditStore ? "on" : "off"})\n`
  );
}
