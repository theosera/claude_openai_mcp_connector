import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { KnowledgeStore } from "../src/knowledgeStore.js";
import { MAX_TOOL_INPUT_ELEMENTS, buildMcpServer } from "../src/server.js";
import { SkillStore } from "../src/skillStore.js";

/**
 * CVE-2026-111768: the MCP SDK validated tool arguments with no bound on their
 * size, and the fixed release ships the bound (`maxToolInputElements`) switched
 * off. These tests pin that the server switches it on, that it reaches inside a
 * value the schema does not look into, and that it sits above every legitimate
 * input.
 */

// The SDK's refusal names the bound. Matching it is what makes a red here say
// "the bound is missing" rather than "some other check refused the call".
const LIMIT_MESSAGE = /arguments contain more than the maximum of 10000 elements/;

const SKILL_MD = `---
name: bound-check
description: Check that a full Skill bundle passes the tool input bound.
---

# Bound check

A bundle with the largest number of references the store accepts.
`;

async function connect(): Promise<Client> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-input-elements-vault-"));
  const patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-input-elements-patches-"));
  await fs.writeFile(path.join(root, "note.md"), "---\ntitle: Note\n---\n\nalpha body\n", "utf8");
  const store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
  await store.init();
  await fs.mkdir(path.join(root, "skills"), { recursive: true });
  const skillStore = new SkillStore({ knowledgeRoot: root, patchStateDir, skillsSubdir: "skills" });
  await skillStore.init();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(store, { allowWrite: true, allowSkillWrite: true, skillStore });
  await server.connect(serverTransport);
  const client = new Client({ name: "tool-input-elements-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((block) => block.text ?? "").join("\n");
}

function tags(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `t${i}`);
}

describe("tools/call arguments are bounded by element count", () => {
  // Literal 10_000, not MAX_TOOL_INPUT_ELEMENTS: an assertion that reads the
  // constant it pins moves with it.
  it("pins the bound", () => {
    expect(MAX_TOOL_INPUT_ELEMENTS).toBe(10_000);
  });

  it("refuses arguments one element over the bound", async () => {
    const client = await connect();
    // The SDK counts object members and array elements: 2 keys + 9,999 tags = 10,001.
    const result = await client.callTool({
      name: "search_documents",
      arguments: { query: "alpha", tags: tags(9_999) }
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(LIMIT_MESSAGE);
  });

  it("accepts arguments exactly at the bound", async () => {
    const client = await connect();
    // 2 keys + 9,998 tags = 10,000.
    const result = await client.callTool({
      name: "search_documents",
      arguments: { query: "alpha", tags: tags(9_998) }
    });
    expect(textOf(result)).not.toMatch(LIMIT_MESSAGE);
    expect(result.isError).not.toBe(true);
  });

  it("counts members nested inside a value the schema does not inspect", async () => {
    // frontmatter_patch is z.record(z.string(), z.unknown()), and the allowlist
    // that rejects an unknown key runs later, in the handler. Without the bound
    // this call is still refused — by the allowlist, with a different message.
    const client = await connect();
    const nested = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, i]));
    const result = await client.callTool({
      name: "plan_document_update",
      arguments: { id_or_path: "note.md", new_body: "body\n", frontmatter_patch: { nested }, reason: "bound check" }
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(LIMIT_MESSAGE);
  });
});

describe("legitimate calls stay under the bound", () => {
  it("plans a Skill bundle with the largest accepted number of references", async () => {
    const client = await connect();
    const references = Array.from({ length: 20 }, (_, i) => ({
      filename: `ref-${i}.md`,
      content: `# Reference ${i}\n\nText.\n`
    }));
    const result = await client.callTool({
      name: "plan_skill_create",
      arguments: { skill_name: "bound-check", skill_md: SKILL_MD, references, reason: "bound check" }
    });
    expect(textOf(result)).not.toMatch(LIMIT_MESSAGE);
    expect(result.isError).not.toBe(true);
  });

  it("runs an ordinary search", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "search_documents", arguments: { query: "alpha", tags: ["a", "b"] } });
    expect(result.isError).not.toBe(true);
  });
});
