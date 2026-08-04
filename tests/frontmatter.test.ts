import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseMarkdown, parseMarkdownSafe, serializeMarkdown } from "../src/frontmatter.js";
import { KnowledgeStore } from "../src/knowledgeStore.js";

const MARKER = "__grayMatterFrontmatterExecuted__";

/**
 * gray-matter honours a language tag after the opening delimiter and hands the
 * block to the matching engine; its bundled `javascript` engine parses with a
 * raw eval(). The payload writes a marker onto globalThis, so the assertions can
 * pin NON-EXECUTION rather than "something threw" — the unpatched write path
 * evaluates the block first and only then throws "stringifying JavaScript is not
 * supported", which would satisfy a mere `toThrow()`.
 *
 * `body` keeps each payload textually distinct: gray-matter memoizes parses by
 * content in a module-global cache, so a payload reused across tests could be
 * served from that cache and look harmless.
 */
function executablePayload(languageTag: string, body = "vault body"): string {
  return `---${languageTag}\nglobalThis[${JSON.stringify(MARKER)}] = "executed";\n---\n\n${body}\n`;
}

function markerValue(): unknown {
  return (globalThis as unknown as Record<string, unknown>)[MARKER];
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)[MARKER];
});

describe("executable front matter is never evaluated", () => {
  // Lower-casing happens inside gray-matter's engine lookup, so these two keys
  // cover every spelling of the JavaScript engine.
  const LANGUAGE_TAGS = ["js", "javascript", "JavaScript"];

  it("refuses a `---js` block on the read path instead of eval'ing it", () => {
    for (const tag of LANGUAGE_TAGS) {
      expect(() => parseMarkdown(executablePayload(tag, `read path ${tag}`))).toThrow(/Executable front matter/);
      expect(markerValue()).toBeUndefined();
    }
  });

  it("degrades a poisoned document the way malformed YAML already does", () => {
    for (const tag of LANGUAGE_TAGS) {
      const raw = executablePayload(tag, `degraded read path ${tag}`);
      const parsed = parseMarkdownSafe(raw);

      expect(markerValue()).toBeUndefined();
      expect(parsed.parseError).toBeDefined();
      expect(parsed.body).toBe(raw); // raw body kept, so the note stays searchable
      expect(parsed.frontmatter).toEqual({ tags: [], source_refs: [] });
    }
  });

  it("keeps one poisoned note from aborting search / list for the whole vault", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-frontmatter-vault-"));
    const patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-frontmatter-patches-"));
    await fs.writeFile(path.join(root, "poisoned.md"), executablePayload("js", "ZZPOISONEDBODY"), "utf8");
    await fs.writeFile(path.join(root, "good.md"), "---\ntitle: Good\n---\n\nZZGOODBODY retrieval notes\n", "utf8");

    const store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
    await store.init();

    await expect(store.listDocuments()).resolves.toHaveLength(2);
    expect((await store.search({ query: "ZZGOODBODY" })).results.map((result) => result.path)).toEqual(["good.md"]);
    expect(markerValue()).toBeUndefined();
  });

  it("refuses a `---js` prefix in a client-supplied body on the write path", () => {
    const body = executablePayload("js", "write path body");
    const output = serializeMarkdown({ id: "note-001", updated_at: "2026-01-01T00:00:00.000Z" }, body);
    const reparsed = parseMarkdown(output);

    expect(markerValue()).toBeUndefined();
    // The body is written through verbatim, never promoted into front matter.
    expect(reparsed.body).toBe(body);
    expect(Object.keys(reparsed.frontmatter)).toEqual(["id", "updated_at", "tags", "source_refs"]);
  });
});

describe("the frontmatter allowlist survives a body that starts with a YAML block", () => {
  it("does not merge body-derived keys into the written front matter", () => {
    const body = "---\nrole: admin\ndate: 2026-01-01\ntype: system\nid: forged\n---\n\nreal body\n";
    const metadata = { id: "note-001", title: "Real title", updated_at: "2026-01-01T00:00:00.000Z" };

    const output = serializeMarkdown(metadata, body);
    const reparsed = parseMarkdown(output);

    // Key set is exactly the server-computed metadata: no `role` / `date` /
    // `type` smuggled in past assertFrontmatterPatch.
    expect(Object.keys(reparsed.frontmatter)).toEqual(["id", "title", "updated_at", "tags", "source_refs"]);
    expect(reparsed.frontmatter.id).toBe("note-001");
    expect(reparsed.frontmatter.title).toBe("Real title");
    // The block stays where the client put it — inside the body.
    expect(reparsed.body).toBe(body);
  });
});

describe("front matter regression baselines", () => {
  it("parses ordinary YAML front matter unchanged", () => {
    const parsed = parseMarkdown("---\ntitle: T\ntags: [a, b]\n---\n\nhello\n");

    expect(parsed.frontmatter.title).toBe("T");
    expect(parsed.frontmatter.tags).toEqual(["a", "b"]);
    expect(parsed.body).toBe("\nhello\n");
    expect(serializeMarkdown(parsed.frontmatter, parsed.body)).toContain("title: T");
  });

  it("round-trips a document whose front matter carries a `__proto__` key", async () => {
    // js-yaml blocks prototype pollution by defining `__proto__` with
    // Object.defineProperty, so it lands as an OWN ENUMERABLE key; gray-matter's
    // Object.assign copy then silently drops it ([[Set]] semantics). Nothing may
    // treat that asymmetry as an error — such a note must stay editable.
    const raw = "---\nid: proto-001\ntitle: Proto\n__proto__:\n  polluted: yes\n---\n\nproto body\n";
    const parsed = parseMarkdown(raw);

    expect(Object.keys(parsed.frontmatter)).toContain("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => serializeMarkdown(parsed.frontmatter, parsed.body)).not.toThrow();

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-frontmatter-vault-"));
    const patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-frontmatter-patches-"));
    await fs.writeFile(path.join(root, "proto.md"), raw, "utf8");
    const store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
    await store.init();

    const plan = await store.planUpdate({ id_or_path: "proto.md", new_body: "updated body\n", reason: "edit" });
    const applied = await store.applyPlannedUpdate(plan.patch_id);

    expect(applied.document.body.trim()).toBe("updated body");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
