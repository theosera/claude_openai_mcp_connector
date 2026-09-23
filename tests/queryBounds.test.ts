import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { KnowledgeStore } from "../src/knowledgeStore.js";
import { MAX_QUERY_LENGTH, MAX_QUERY_TERMS, tokenize } from "../src/search.js";
import { buildMcpServer } from "../src/server.js";

/**
 * F2 of the 2026-09-19 scan: a query's cost is terms x corpus, and neither
 * factor had a bound, so one 4 MiB request held the event loop with ~450,000
 * terms. The module bounds its own term count; the schemas bound the string.
 */
describe("tokenize bounds the number of terms", () => {
  // Literal 64, not MAX_QUERY_TERMS: an assertion that reads the constant it
  // pins moves with it, and "no bound" then satisfies "at most the bound".
  it("stops at 64 distinct terms", () => {
    expect(MAX_QUERY_TERMS).toBe(64);
    const query = Array.from({ length: 1000 }, (_, i) => `term${i}`).join(" ");
    const terms = tokenize(query);
    expect(terms).toHaveLength(64);
    // The first terms are kept, in query order.
    expect(terms[0].text).toBe("term0");
    expect(terms[MAX_QUERY_TERMS - 1].text).toBe(`term${MAX_QUERY_TERMS - 1}`);
  });

  it("counts CJK segments against the same bound", () => {
    // One whitespace-free token whose segments alone exceed the bound:
    // uncapped, these 400 ideographs tokenize to 396 terms (1 whole + 395).
    const token = Array.from({ length: 400 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
    expect(tokenize(token)).toHaveLength(64);
  });

  it("leaves an ordinary query unchanged", () => {
    expect(tokenize("alpha beta alpha").map((term) => term.text)).toEqual(["alpha", "beta"]);
  });
});

describe("query schemas bound the query string", () => {
  async function connect() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-query-bounds-"));
    await fs.writeFile(path.join(root, "note.md"), "---\ntitle: Note\n---\n\nalpha body\n", "utf8");
    const patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-query-bounds-patches-"));
    const store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
    await store.init();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(store, { allowWrite: false, includeChatgptCompat: true });
    await server.connect(serverTransport);
    const client = new Client({ name: "query-bounds-test", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  /** A refusal may arrive as an error result or as a thrown protocol error. */
  async function refused(client: Client, name: string, query: string): Promise<boolean> {
    try {
      const result = await client.callTool({ name, arguments: { query } });
      return result.isError === true;
    } catch {
      return true;
    }
  }

  it.each(["search_documents", "get_context", "search"])("%s refuses a query over MAX_QUERY_LENGTH", async (name) => {
    expect(MAX_QUERY_LENGTH).toBe(2048);
    const client = await connect();
    expect(await refused(client, name, "a".repeat(MAX_QUERY_LENGTH + 1))).toBe(true);
    // The boundary itself is accepted, so the refusal above is the length and
    // not something else about the call.
    expect(await refused(client, name, "a".repeat(MAX_QUERY_LENGTH))).toBe(false);
  });
});
