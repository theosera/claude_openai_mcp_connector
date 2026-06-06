#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { KnowledgeStore } from "./knowledgeStore.js";

const server = new McpServer(
  {
    name: "claude-openai-markdown-connector",
    version: "0.1.0"
  },
  {
    instructions:
      "Use this server to search, fetch, trace, create, and safely update a private Markdown vault. Existing document edits must use plan_document_update first, then apply_planned_update only after the user approves the diff."
  }
);

const store = new KnowledgeStore(loadConfig());
await store.init();

server.registerTool(
  "search_documents",
  {
    title: "Search Markdown documents",
    description: "Search Markdown documents in the private knowledge vault.",
    inputSchema: {
      query: z.string().default(""),
      client: z.string().optional(),
      project: z.string().optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(50).optional()
    }
  },
  async (input) => jsonResult(await store.search(input))
);

server.registerTool(
  "fetch_document",
  {
    title: "Fetch Markdown document",
    description: "Fetch a Markdown document by frontmatter id or vault-relative path.",
    inputSchema: {
      id_or_path: z.string()
    }
  },
  async (input) => jsonResult(await store.fetch(input.id_or_path))
);

server.registerTool(
  "list_projects",
  {
    title: "List projects",
    description: "List projects discovered from Markdown frontmatter.",
    inputSchema: {
      client: z.string().optional(),
      tags: z.array(z.string()).optional()
    }
  },
  async (input) => jsonResult(await store.listProjects(input.client, input.tags))
);

server.registerTool(
  "create_document",
  {
    title: "Create Markdown document",
    description: "Create a new Markdown document. Existing files are never overwritten.",
    inputSchema: {
      client: z.string(),
      project: z.string(),
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()).optional(),
      source_refs: z.array(z.string()).optional()
    }
  },
  async (input) => jsonResult(await store.createDocument(input))
);

server.registerTool(
  "plan_document_update",
  {
    title: "Plan Markdown update",
    description: "Create a diff proposal for an existing Markdown document without modifying the file.",
    inputSchema: {
      id_or_path: z.string(),
      new_body: z.string(),
      frontmatter_patch: z.record(z.unknown()).optional(),
      reason: z.string()
    }
  },
  async (input) => jsonResult(await store.planUpdate(input))
);

server.registerTool(
  "apply_planned_update",
  {
    title: "Apply planned Markdown update",
    description: "Apply a previously planned update after validating that the target file has not changed.",
    inputSchema: {
      patch_id: z.string()
    }
  },
  async (input) => jsonResult(await store.applyPlannedUpdate(input.patch_id))
);

server.registerTool(
  "trace_sources",
  {
    title: "Trace document sources",
    description: "Return source refs, outgoing local links, and backlink candidates for a document.",
    inputSchema: {
      id_or_path: z.string()
    }
  },
  async (input) => jsonResult(await store.traceSources(input.id_or_path))
);

const transport = new StdioServerTransport();
await server.connect(transport);

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: { data: value }
  };
}
