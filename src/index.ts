#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadHttpConfig, selectedTransport } from "./config.js";
import { startHttpServer } from "./httpServer.js";
import { AuditStore } from "./auditStore.js";
import { createStore } from "./multiRootStore.js";
import { buildMcpServer } from "./server.js";
import { SkillStore } from "./skillStore.js";

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
}
