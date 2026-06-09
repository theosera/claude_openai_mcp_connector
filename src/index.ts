#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadHttpConfig, selectedTransport } from "./config.js";
import { startHttpServer } from "./httpServer.js";
import { KnowledgeStore } from "./knowledgeStore.js";
import { buildMcpServer } from "./server.js";

const store = new KnowledgeStore(loadConfig());
await store.init();

const transport = selectedTransport();

if (transport === "http") {
  // Remote Streamable HTTP endpoint for Chat connectors (ChatGPT / Claude.ai).
  // Read-only by default; bearer-authenticated; binds to 127.0.0.1.
  const httpConfig = loadHttpConfig();
  const httpServer = await startHttpServer(store, httpConfig);
  const address = httpServer.address();
  const where =
    typeof address === "object" && address
      ? `${address.address}:${address.port}`
      : `${httpConfig.host}:${httpConfig.port}`;
  // stderr only — stdout is reserved for protocol data on stdio, and we keep
  // logs free of the auth token or any vault content.
  process.stderr.write(
    `MCP HTTP transport listening on http://${where}/mcp ` +
      `(write=${httpConfig.allowWrite ? "on" : "off"}, oauth=${httpConfig.oauth ? "on" : "off"})\n`
  );
} else {
  // Local stdio transport for CLI clients (Claude Code, Codex, Claude Desktop).
  const server = buildMcpServer(store, { allowWrite: true, includeChatgptCompat: true });
  await server.connect(new StdioServerTransport());
}
