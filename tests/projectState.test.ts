import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { KnowledgeStore } from "../src/knowledgeStore.js";
import { outlineOf, selectSections } from "../src/markdownSections.js";
import {
  buildProjectState,
  DEFAULT_PROJECT_STATE_TAG,
  MAX_PROJECT_STATE_BUDGET,
  MIN_PROJECT_STATE_BUDGET,
  RECENT_DOCS_LIMIT,
  SESSION_CLIENT
} from "../src/projectState.js";
import { searchDocuments } from "../src/search.js";
import { buildMcpServer } from "../src/server.js";
import { estimateTokens } from "../src/tokenEstimate.js";
import type { GetProjectStateInput, MarkdownDocument, SearchFilters, VaultStore } from "../src/types.js";

function note(
  relativePath: string,
  body = "",
  overrides: Partial<MarkdownDocument> & { frontmatter?: MarkdownDocument["frontmatter"] } = {}
): MarkdownDocument {
  const prefixed = overrides.root ? `${overrides.root}:${relativePath}` : relativePath;
  return {
    id: overrides.id ?? prefixed,
    relativePath: prefixed,
    absolutePath: `/synthetic/${prefixed}`,
    frontmatter: overrides.frontmatter ?? {},
    body,
    title: overrides.title ?? relativePath.slice(relativePath.lastIndexOf("/") + 1).replace(/\.md$/i, ""),
    ...(overrides.root ? { root: overrides.root } : {}),
    stats: overrides.stats ?? { sizeBytes: body.length, modifiedAt: "2026-01-01T00:00:00.000Z" }
  };
}

function storeOver(documents: MarkdownDocument[]): VaultStore {
  const unsupported = () => {
    throw new Error("not used by the project-state builder");
  };
  return {
    init: async () => undefined,
    search: async (filters: SearchFilters) => searchDocuments(documents, filters),
    listDocuments: async () => documents,
    fetch: unsupported,
    listProjects: unsupported,
    createDocument: unsupported,
    planDocumentCreate: unsupported,
    applyPlannedDocumentCreate: unsupported,
    planUpdate: unsupported,
    applyPlannedUpdate: unsupported,
    traceSources: unsupported
  } as unknown as VaultStore;
}

function build(documents: MarkdownDocument[], input: GetProjectStateInput) {
  return buildProjectState(storeOver(documents), input);
}

/** A session archive: the `client` and tag the archive hook writes, and a body
 *  big enough that inlining it would be the whole answer. */
function session(name: string, updatedAt: string, headings: string[] = ["Turn 1", "Turn 2"]): MarkdownDocument {
  const body = headings.map((heading) => `## ${heading}\n\n${"transcript line. ".repeat(500)}`).join("\n\n");
  return note(`sessions/${name}.md`, body, {
    frontmatter: {
      project: "connector",
      client: SESSION_CLIENT,
      tags: ["claude-code-session"],
      updated_at: updatedAt
    }
  });
}

describe("get_project_state input bounds", () => {
  it("requires a project", async () => {
    await expect(build([note("a.md")], { project: "" })).rejects.toThrow(/requires a project/);
    await expect(build([note("a.md")], { project: "   " })).rejects.toThrow(/requires a project/);
  });

  it("rejects a budget outside its declared range", async () => {
    const documents = [note("a.md", "x", { frontmatter: { project: "connector" } })];
    await expect(
      build(documents, { project: "connector", token_budget: MIN_PROJECT_STATE_BUDGET - 1 })
    ).rejects.toThrow(/token_budget/);
    await expect(
      build(documents, { project: "connector", token_budget: MAX_PROJECT_STATE_BUDGET + 1 })
    ).rejects.toThrow(/token_budget/);
    // The false-positive guard: a valid budget must still work.
    await expect(build(documents, { project: "connector", token_budget: 1000 })).resolves.toBeTruthy();
  });
});

describe("get_project_state does not synthesize", () => {
  it("returns no free-text summary, blockers or next-steps field", async () => {
    // ⚠️ The honesty boundary, asserted on the KEY SET rather than on the
    // absence of one name. A schema that grows a `summary: string` later would
    // pass a test that only checked for `blockers`.
    const state = await build([note("a.md", "x", { frontmatter: { project: "connector" } })], { project: "connector" });

    expect(Object.keys(state).sort()).toEqual([
      "ops_recent",
      "recent_docs",
      "recent_sessions",
      "state_docs",
      "summary"
    ]);
    expect(Object.keys(state.summary).sort()).toEqual(["doc_count", "latest_ts", "roots"]);
    // `summary` is counters, not prose — nothing in it is a string a model wrote.
    expect(typeof state.summary.doc_count).toBe("number");
    expect(Array.isArray(state.summary.roots)).toBe(true);
  });

  it("surfaces a designated state document verbatim instead", async () => {
    // The place a conclusion DOES belong: a note someone wrote, returned whole.
    const documents = [
      note("state.md", "The decision was to key on path.", {
        frontmatter: { project: "connector", tags: [DEFAULT_PROJECT_STATE_TAG] }
      }),
      note("other.md", "unrelated detail", { frontmatter: { project: "connector" } })
    ];

    const state = await build(documents, { project: "connector" });
    expect(state.state_docs).toHaveLength(1);
    expect(state.state_docs[0].text).toBe("The decision was to key on path.");
    expect(state.state_docs[0].truncated).toBe(false);
  });

  it("honours an operator-configured state tag", async () => {
    const documents = [note("state.md", "text", { frontmatter: { project: "connector", tags: ["dossier"] } })];
    const withDefault = await buildProjectState(storeOver(documents), { project: "connector" });
    const withCustom = await buildProjectState(storeOver(documents), { project: "connector" }, { stateTag: "dossier" });

    expect(withDefault.state_docs).toHaveLength(0);
    expect(withCustom.state_docs).toHaveLength(1);
  });

  it("truncates a state document to the budget and says so", async () => {
    const documents = [
      note("state.md", "state sentence. ".repeat(4000), {
        frontmatter: { project: "connector", tags: [DEFAULT_PROJECT_STATE_TAG] }
      })
    ];

    const state = await build(documents, { project: "connector", token_budget: MIN_PROJECT_STATE_BUDGET });
    expect(state.state_docs[0].truncated).toBe(true);
    expect(state.state_docs[0].est_tokens).toBeLessThanOrEqual(MIN_PROJECT_STATE_BUDGET);
    expect(state.state_docs[0].text.length).toBeGreaterThan(0);
  });
});

describe("get_project_state never inlines a session archive", () => {
  const documents = [
    session("2026-08-16", "2026-08-16T10:00:00.000Z", ["Setup", "Investigation"]),
    session("2026-08-15", "2026-08-15T10:00:00.000Z"),
    note("plain.md", "an ordinary note", {
      frontmatter: { project: "connector", updated_at: "2026-08-14T10:00:00.000Z" }
    })
  ];

  it("carries metadata and an outline, and no body at any index", async () => {
    // ⚠️ The size-asymmetry rule. One of these notes is orders of magnitude
    // larger than the rest, so "return the project's documents" is two
    // behaviours, not one.
    const state = await build(documents, { project: "connector" });

    expect(state.recent_sessions).toHaveLength(2);
    // ⚠️ Assert the whole key set, not the absence of three names I happened to
    // think of. `not.toContain("text")` passes for a field called `transcript`,
    // and the rule is "no body reaches this list", not "not these three".
    expect(Object.keys(state.recent_sessions[0]).sort()).toEqual([
      "id",
      "outline",
      "path",
      "size_bytes",
      "title",
      "updated_at"
    ]);
    expect(Object.keys(state.recent_sessions[1]).sort()).toEqual(["id", "path", "size_bytes", "title", "updated_at"]);
    for (const entry of state.recent_sessions) {
      expect(entry.size_bytes).toBeGreaterThan(0);
    }
    // Newest first, and only the newest carries an outline.
    expect(state.recent_sessions[0].path).toBe("sessions/2026-08-16.md");
    expect(state.recent_sessions[0].outline?.map((entry) => entry.heading)).toEqual(["Setup", "Investigation"]);
    expect(state.recent_sessions[1].outline).toBeUndefined();
  });

  it("keeps session archives out of recent_docs, where a snippet would be useless", async () => {
    const state = await build(documents, { project: "connector" });
    expect(state.recent_docs.map((entry) => entry.path)).toEqual(["plain.md"]);
    // The false-positive guard: ordinary notes DO get a snippet.
    expect(state.recent_docs[0].snippet).toBe("an ordinary note");
    // ⚠️ And a snippet is ALL they get. Asserting the key set rather than the
    // absence of one name: measured, adding a `text: document.body` field here
    // left every test green, because nothing pinned what a recent_doc may hold.
    expect(Object.keys(state.recent_docs[0]).sort()).toEqual([
      "id",
      "path",
      "size_bytes",
      "snippet",
      "title",
      "updated_at"
    ]);
  });
});

describe("get_project_state ops pointers", () => {
  it("reaches ops logs through target_repo, and returns pointers only", async () => {
    const documents = [
      note("ops/2026-08-16.md", "a full command transcript", {
        root: "ops",
        frontmatter: { target_repo: "connector", updated_at: "2026-08-16T09:00:00.000Z" }
      }),
      note("ops/other.md", "different repo", { root: "ops", frontmatter: { target_repo: "something-else" } })
    ];

    const state = await build(documents, { project: "connector" });
    expect(state.ops_recent).toHaveLength(1);
    // ⚠️ `target_repo` is frontmatter, so any note can join this list. It is a
    // pointer list for exactly that reason — no body rides on a self-declared
    // field, and every path here is one the same caller could enumerate anyway.
    expect(Object.keys(state.ops_recent[0]).sort()).toEqual(["date", "path", "root"]);
    expect(state.ops_recent[0].path).toBe("ops:ops/2026-08-16.md");
  });
});

describe("get_project_state shape", () => {
  const documents = [
    note("a.md", "first", { frontmatter: { project: "connector", updated_at: "2026-08-10T00:00:00.000Z" } }),
    note("b.md", "second", { frontmatter: { project: "connector", updated_at: "2026-08-11T00:00:00.000Z" } }),
    note("c.md", "other project", { frontmatter: { project: "elsewhere" } })
  ];

  it("counts only the project's own documents", async () => {
    const state = await build(documents, { project: "connector" });
    expect(state.summary.doc_count).toBe(2);
    expect(state.summary.latest_ts).toBe("2026-08-11T00:00:00.000Z");
  });

  it("filters by client when asked", async () => {
    const withClient = [
      ...documents,
      note("d.md", "claude only", { frontmatter: { project: "connector", client: "claude" } })
    ];
    expect((await build(withClient, { project: "connector", client: "claude" })).summary.doc_count).toBe(1);
  });

  it("builds only the requested sections", async () => {
    const state = await build(documents, { project: "connector", include: ["recent_docs"] });
    expect(state.recent_docs.length).toBeGreaterThan(0);
    expect(state.state_docs).toEqual([]);
    expect(state.recent_sessions).toEqual([]);
    expect(state.ops_recent).toEqual([]);
  });

  it("leaves out a section that was not requested", async () => {
    // ⚠️ The other direction, and the one the test above cannot reach: it only
    // ever showed that the sections NOT named came back empty, which is also
    // what an ignored `include` produces when the vault has nothing for them.
    // Measured — forcing `recent_docs` to always build left every test green.
    const state = await build(documents, { project: "connector", include: ["state_docs"] });
    expect(state.recent_docs).toEqual([]);
    // ...and the same documents do populate it when it IS requested, so the
    // emptiness above is the filter and not an empty vault.
    expect((await build(documents, { project: "connector", include: ["recent_docs"] })).recent_docs.length).toBe(2);
  });

  it("caps recent_docs and orders them deterministically", async () => {
    // Every note shares a timestamp, so the tie-break is the only thing
    // deciding the order — which is what makes this test about determinism
    // rather than about sorting.
    const many = Array.from({ length: RECENT_DOCS_LIMIT + 5 }, (_, index) =>
      note(`n-${String(index).padStart(2, "0")}.md`, "body", {
        frontmatter: { project: "connector", updated_at: "2026-08-10T00:00:00.000Z" }
      })
    );
    const first = await build(many, { project: "connector" });
    const second = await build([...many].reverse(), { project: "connector" });

    expect(first.recent_docs).toHaveLength(RECENT_DOCS_LIMIT);
    expect(second.recent_docs.map((entry) => entry.path)).toEqual(first.recent_docs.map((entry) => entry.path));
  });

  it("returns an empty dossier for a project with nothing in it", async () => {
    const state = await build(documents, { project: "no-such-project" });
    expect(state.summary).toEqual({ doc_count: 0, latest_ts: undefined, roots: [] });
    expect(state.state_docs).toEqual([]);
  });
});

describe("outlineOf", () => {
  it("measures a section to the next heading at its level or above, not the next heading", async () => {
    // ⚠️ A `###` does not end a `##`. Counting to the next heading of any level
    // would report every parent as the length of its own first paragraph — the
    // number a caller uses to decide whether to fetch it.
    const body = ["# Top", "intro", "## First", "a".repeat(100), "### Nested", "b".repeat(100), "## Second", "c"].join(
      "\n"
    );
    const outline = outlineOf(body);

    const first = outline.find((entry) => entry.heading === "First");
    const nested = outline.find((entry) => entry.heading === "Nested");
    expect(first && nested && first.chars > nested.chars).toBe(true);
    expect(nested?.heading_path).toEqual(["Top", "First", "Nested"]);
    expect(outline[0].start_line).toBe(1);
    expect(outline.every((entry) => entry.est_tokens > 0)).toBe(true);
  });

  it("ignores headings inside a fenced code block", async () => {
    const body = ["# Real", "```md", "## Not A Heading", "```", "## Also Real"].join("\n");
    expect(outlineOf(body).map((entry) => entry.heading)).toEqual(["Real", "Also Real"]);
  });
});

describe("selectSections", () => {
  const body = [
    "# Doc",
    "intro",
    "## Design",
    "design text",
    "### Rejected",
    "rejected text",
    "## Other",
    "other"
  ].join("\n");

  it("takes a section with its subsections", async () => {
    const { text, matched } = selectSections(body, ["Design"]);
    expect(text).toContain("design text");
    expect(text).toContain("rejected text");
    expect(text).not.toContain("other");
    expect(matched).toEqual(["Design"]);
  });

  it("takes a subsection alone through its heading path", async () => {
    const { text } = selectSections(body, ["Doc/Design/Rejected"]);
    expect(text).toContain("rejected text");
    expect(text).not.toContain("design text");
  });

  it("does not return a subsection twice when its parent also matched", async () => {
    // ⚠️ Overlapping ranges. Emitting both would look like duplicated content
    // in the note rather than an artifact of the request.
    const { text } = selectSections(body, ["Design", "Doc/Design/Rejected"]);
    expect(text.match(/rejected text/g)).toHaveLength(1);
  });

  it("matches case-insensitively and across normalization forms", async () => {
    const composed = "設計";
    const japanese = `# ${composed}\n本文\n`;
    expect(selectSections(japanese, [composed.normalize("NFD")]).text).toContain("本文");
    expect(selectSections(body, ["design"]).matched).toEqual(["design"]);
  });

  it("reports which requests missed", async () => {
    // A mistyped heading has to be visible; silently returning less is the
    // failure mode a caller cannot detect.
    expect(selectSections(body, ["Design", "Nonexistent"]).matched).toEqual(["Design"]);
  });

  it("credits every selector that matched, not just the first", async () => {
    // ⚠️ Overlapping selectors both hit this heading. Recording only the first
    // reported the other as a miss — and `sections_matched` is exactly what a
    // caller uses to decide whether to retry, so a false miss sends it back to
    // re-request a selector that already worked.
    // ⚠️ The section must have NO subsections. With `["Design", "Doc/Design"]`
    // the path selector is credited again at the nested `Rejected` heading, so
    // recording only the first hit still ends up crediting both and the fixture
    // proves nothing — measured, it passed with the defect in place. `Other` is
    // a leaf, so the overlap happens at one heading and nowhere else.
    const { matched } = selectSections(body, ["Other", "Doc/Other"]);
    expect(matched.sort()).toEqual(["Doc/Other", "Other"]);
  });

  it("matches a closed ATX heading by the name the outline shows", async () => {
    // ⚠️ Two compounding failures, not one: the outline displayed `Setup ##`,
    // and the name a caller would type after reading it then matched nothing.
    // The outline is where the selector comes from.
    const closed = "## Setup ##\nsetup text\n\n## Findings\nfinding text";
    expect(outlineOf(closed).map((entry) => entry.heading)).toEqual(["Setup", "Findings"]);
    expect(selectSections(closed, ["Setup"]).text).toContain("setup text");

    // The false-positive guard: a hash that is part of the name stays.
    expect(outlineOf("## C#\ntext").map((entry) => entry.heading)).toEqual(["C#"]);
  });
});

describe("fetch_document sectioning over the wire", () => {
  async function client(): Promise<{ client: Client; cleanup: () => Promise<void> }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-p4-vault-"));
    const patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-p4-patches-"));
    await fs.writeFile(
      path.join(root, "big.md"),
      ["---", "id: big-001", "---", "# Session", "intro", "## Setup", "setup text", "## Findings", "finding text"].join(
        "\n"
      ),
      "utf8"
    );
    const store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
    await store.init();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(store, { allowWrite: false });
    await server.connect(serverTransport);
    const connected = new Client({ name: "p4-test", version: "0.0.0" });
    await connected.connect(clientTransport);
    return {
      client: connected,
      cleanup: async () => {
        await connected.close();
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(patchStateDir, { recursive: true, force: true });
      }
    };
  }

  const dataOf = (result: unknown): Record<string, unknown> =>
    (result as { structuredContent: { data: Record<string, unknown> } }).structuredContent.data;

  it("returns the whole document, unchanged, when no projection is asked for", async () => {
    // The compatibility half: every parameter is optional, and omitting them all
    // must reproduce exactly the response that existed before P4.
    const { client: connected, cleanup } = await client();
    const data = dataOf(await connected.callTool({ name: "fetch_document", arguments: { id_or_path: "big-001" } }));

    expect(data.body).toContain("setup text");
    expect(data.body).toContain("finding text");
    expect(data).not.toHaveProperty("truncated");
    expect(data).not.toHaveProperty("total_chars");
    expect(data).not.toHaveProperty("outline");
    await cleanup();
  });

  it("returns an outline INSTEAD of a body", async () => {
    // Returning both would make the expensive case cost more than the plain
    // fetch this exists to avoid.
    const { client: connected, cleanup } = await client();
    const data = dataOf(
      await connected.callTool({ name: "fetch_document", arguments: { id_or_path: "big-001", outline: true } })
    );

    expect(data.body).toBe("");
    expect((data.outline as { heading: string }[]).map((entry) => entry.heading)).toEqual([
      "Session",
      "Setup",
      "Findings"
    ]);
    await cleanup();
  });

  it("narrows to the requested sections and says what the whole note was", async () => {
    const { client: connected, cleanup } = await client();
    const data = dataOf(
      await connected.callTool({ name: "fetch_document", arguments: { id_or_path: "big-001", sections: ["Setup"] } })
    );

    expect(data.body).toContain("setup text");
    expect(data.body).not.toContain("finding text");
    expect(data.truncated).toBe(true);
    expect(data.sections_matched).toEqual(["Setup"]);
    // ⚠️ `total_chars` is the WHOLE document's length, never the slice's — a
    // caller that cannot tell how much it did not receive is back to guessing.
    expect(data.total_chars).toBeGreaterThan((data.body as string).length);
    await cleanup();
  });

  it("still reports sections_matched when the selection is the whole document", async () => {
    // ⚠️ The projection was detected by comparing the RESULT to the original.
    // A note that is one heading with no sibling returns its whole text for a
    // correct selector, so the successful case took the legacy path and dropped
    // the very signal a caller needs — leaving a hit indistinguishable from a
    // typo in exactly the request that worked perfectly.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-p4-whole-"));
    const patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-p4-whole-state-"));
    await fs.writeFile(path.join(root, "one.md"), "---\nid: one-001\n---\n# Only\nall of the text\n", "utf8");
    const store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
    await store.init();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(store, { allowWrite: false });
    await server.connect(serverTransport);
    const connected = new Client({ name: "p4-whole", version: "0.0.0" });
    await connected.connect(clientTransport);

    const data = dataOf(
      await connected.callTool({ name: "fetch_document", arguments: { id_or_path: "one-001", sections: ["Only"] } })
    );
    expect(data.sections_matched).toEqual(["Only"]);
    // Nothing was cut, and the response says so rather than claiming it was.
    expect(data.truncated).toBe(false);
    expect(data.total_chars).toBe((data.body as string).length);

    await connected.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(patchStateDir, { recursive: true, force: true });
  });

  it("truncates to max_chars", async () => {
    const { client: connected, cleanup } = await client();
    const data = dataOf(
      await connected.callTool({ name: "fetch_document", arguments: { id_or_path: "big-001", max_chars: 12 } })
    );

    expect((data.body as string).length).toBe(12);
    expect(data.truncated).toBe(true);
    expect(data.total_chars).toBeGreaterThan(12);
    await cleanup();
  });

  it("registers get_project_state as a read tool", async () => {
    const { client: connected, cleanup } = await client();
    const names = (await connected.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("get_project_state");
    expect(names).toContain("get_context");
    await cleanup();
  });

  it("estimates a state document's cost the same way the packer does", async () => {
    // One estimator, so a budget spent here and a budget spent in `get_context`
    // mean the same thing. Two would drift.
    const documents = [
      note("state.md", "text about the project", {
        frontmatter: { project: "connector", tags: [DEFAULT_PROJECT_STATE_TAG] }
      })
    ];
    const state = await build(documents, { project: "connector" });
    expect(state.state_docs[0].est_tokens).toBe(estimateTokens("text about the project"));
  });
});
