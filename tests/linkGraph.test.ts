import { describe, expect, it } from "vitest";
import {
  buildLinkGraph,
  HUB_DEGREE_THRESHOLD,
  MAX_EXPANSION_FANOUT,
  MAX_LINK_GRAPH_DEPTH,
  MAX_RELATED_NODES,
  traceThroughGraph
} from "../src/linkGraph.js";
import type { MarkdownDocument } from "../src/types.js";

/**
 * `buildLinkGraph` never touches `fs` — it is handed documents the store
 * already enumerated — so these fixtures are built in memory. That is not a
 * shortcut: it is why the graph's rules can be pinned without a vault at all,
 * and it sidesteps the "two asserts about one path, read through two handles"
 * shape CodeQL flagged on #106 / #107 / #108, since nothing here is on disk.
 * The store-level integration lives in knowledgeStore / multiRootStore tests.
 */

interface NoteOptions {
  id?: string;
  title?: string;
  aliases?: unknown;
  root?: string;
  modifiedAt?: string;
}

function note(relativePath: string, body = "", options: NoteOptions = {}): MarkdownDocument {
  const prefixed = options.root ? `${options.root}:${relativePath}` : relativePath;
  const basename = relativePath.slice(relativePath.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  return {
    id: options.id ?? prefixed,
    relativePath: prefixed,
    absolutePath: `/synthetic/${prefixed}`,
    frontmatter: {
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.aliases === undefined ? {} : { aliases: options.aliases })
    },
    body,
    // Mirrors titleFromMarkdown's fallback: the filename when nothing else.
    title: options.title ?? basename,
    ...(options.root ? { root: options.root } : {}),
    stats: { sizeBytes: body.length, modifiedAt: options.modifiedAt ?? "2026-01-01T00:00:00.000Z" }
  };
}

function linkNamed(graph: ReturnType<typeof buildLinkGraph>, key: string, raw: string) {
  const link = graph.outgoing(key).find((candidate) => candidate.raw === raw);
  if (!link) {
    throw new Error(`no outgoing link ${JSON.stringify(raw)} on ${key}; got ${JSON.stringify(graph.outgoing(key))}`);
  }
  return link;
}

describe("linkGraph resolution (P2-D0: path facts only)", () => {
  // ── 事前登録 A-3: the false-negative guard. Without this, a resolver that
  // refuses everything satisfies A-1 and A-2 and looks correct.
  it("resolves a wikilink whose name matches exactly one note's filename", () => {
    const graph = buildLinkGraph([note("index.md", "[[alpha]]"), note("notes/alpha.md")]);

    const link = linkNamed(graph, "index.md", "alpha");
    expect(link.resolved).toBe(true);
    expect(link.target_path).toBe("notes/alpha.md");
    expect(link.candidates).toBeUndefined();
    expect(graph.incoming("notes/alpha.md").map((node) => node.path)).toEqual(["index.md"]);
  });

  // ── 事前登録 A-4: the ONLY shape where the exact-path leg and the basename
  // leg come apart. Without it, "path facts only" is verified on one leg.
  it("resolves a folder-qualified wikilink even when that basename is ambiguous", () => {
    const graph = buildLinkGraph([
      note("index.md", "[[projects/a/note]]\n[[note]]"),
      note("projects/a/note.md"),
      note("projects/b/note.md")
    ]);

    const qualified = linkNamed(graph, "index.md", "projects/a/note");
    expect(qualified.resolved).toBe(true);
    expect(qualified.target_path).toBe("projects/a/note.md");

    // ...while the bare form stays ambiguous, which is what makes the exact
    // path leg load-bearing rather than a duplicate of the basename leg.
    const bare = linkNamed(graph, "index.md", "note");
    expect(bare.resolved).toBe(false);
    expect(bare.candidates?.map((candidate) => candidate.path)).toEqual(["projects/a/note.md", "projects/b/note.md"]);
    expect(bare.candidates?.every((candidate) => candidate.via === "basename")).toBe(true);
  });

  it("does not retarget a folder-qualified wikilink to some other folder's file", () => {
    // `projects/a/note.md` does not exist. Shrinking the link to its basename
    // would hand it `elsewhere/note.md`, inventing an edge across folders.
    const graph = buildLinkGraph([note("index.md", "[[projects/a/note]]"), note("elsewhere/note.md")]);

    const link = linkNamed(graph, "index.md", "projects/a/note");
    expect(link.resolved).toBe(false);
    expect(link.target_path).toBeUndefined();
    expect(graph.incoming("elsewhere/note.md")).toEqual([]);
  });

  // ── 事前登録 A-1: a UNIQUE title still refuses. Counting only "did it
  // resolve" would pass with the refusal deleted, so the candidates are the
  // half that actually pins the rule.
  it("refuses a uniquely-matching frontmatter title, and says what it could have meant", () => {
    const graph = buildLinkGraph([
      note("index.md", "[[Grand Unified Theory]]"),
      note("notes/alpha.md", "", { title: "Grand Unified Theory" })
    ]);

    const link = linkNamed(graph, "index.md", "Grand Unified Theory");
    expect(link.resolved).toBe(false);
    expect(link.target_path).toBeUndefined();
    // Non-empty is the point: an empty list would mean the link failed for some
    // other reason and this test would be pinning nothing.
    expect(link.candidates).toHaveLength(1);
    expect(link.candidates?.[0]).toMatchObject({ path: "notes/alpha.md", via: "title" });
    // ...and no edge was created, so the refusal reaches the graph too.
    expect(graph.incoming("notes/alpha.md")).toEqual([]);
  });

  // ── 事前登録 A-2: same for aliases.
  it("refuses a uniquely-matching alias, and says what it could have meant", () => {
    const graph = buildLinkGraph([
      note("index.md", "[[GUT]]"),
      note("notes/alpha.md", "", { title: "Alpha", aliases: ["GUT", "Theory"] })
    ]);

    const link = linkNamed(graph, "index.md", "GUT");
    expect(link.resolved).toBe(false);
    expect(link.candidates).toHaveLength(1);
    expect(link.candidates?.[0]).toMatchObject({ path: "notes/alpha.md", via: "alias" });
    expect(graph.incoming("notes/alpha.md")).toEqual([]);
  });

  it("accepts a single-string alias and ignores a malformed one", () => {
    const graph = buildLinkGraph([
      note("index.md", "[[Solo]]\n[[Broken]]"),
      note("notes/solo.md", "", { aliases: "Solo" }),
      note("notes/broken.md", "", { aliases: { nested: "Broken" } })
    ]);

    expect(linkNamed(graph, "index.md", "Solo").candidates?.[0]).toMatchObject({
      path: "notes/solo.md",
      via: "alias"
    });
    expect(linkNamed(graph, "index.md", "Broken").candidates).toBeUndefined();
  });

  // ── 事前登録 A: count the refusals, not just the resolutions. A resolver
  // stuck at "always resolve" grows the first number and empties the second.
  it("counts both halves: what resolved AND what deliberately did not", () => {
    const graph = buildLinkGraph([
      note(
        "index.md",
        [
          "[[alpha]]", // basename, unique      -> resolved
          "[[projects/a/note]]", // exact path  -> resolved
          "[[note]]", // basename, ambiguous    -> refused, candidates
          "[[Grand Unified Theory]]", // title  -> refused, candidates
          "[[Nickname]]", // alias              -> refused, candidates
          "[[nothing-at-all]]" // no match      -> refused, no candidates
        ].join("\n")
      ),
      note("notes/alpha.md", "", { title: "Grand Unified Theory", aliases: ["Nickname"] }),
      note("projects/a/note.md"),
      note("projects/b/note.md")
    ]);

    const links = graph.outgoing("index.md");
    expect(links).toHaveLength(6);
    expect(links.filter((link) => link.resolved)).toHaveLength(2);

    const refused = links.filter((link) => !link.resolved);
    expect(refused).toHaveLength(4);
    expect(refused.filter((link) => (link.candidates?.length ?? 0) > 0)).toHaveLength(3);
  });

  it("resolves a Markdown link against the linking note's own directory", () => {
    const graph = buildLinkGraph([
      note("projects/chatgpt/research/shared.md", "[plan](../../claude/planning/plan.md)"),
      note("projects/claude/planning/plan.md")
    ]);

    const link = linkNamed(graph, "projects/chatgpt/research/shared.md", "../../claude/planning/plan.md");
    expect(link.resolved).toBe(true);
    expect(link.target_path).toBe("projects/claude/planning/plan.md");
  });

  it("leaves a Markdown link that climbs out of the root unresolved", () => {
    const graph = buildLinkGraph([note("a/deep.md", "[out](../../../secrets/key.md)"), note("secrets/key.md")]);

    expect(linkNamed(graph, "a/deep.md", "../../../secrets/key.md").resolved).toBe(false);
    expect(graph.incoming("secrets/key.md")).toEqual([]);
  });

  it("completes `.md` in both directions", () => {
    const graph = buildLinkGraph([note("index.md", "[[alpha.md]]\n[bare](notes/alpha)"), note("notes/alpha.md")]);

    expect(linkNamed(graph, "index.md", "alpha.md").target_path).toBe("notes/alpha.md");
    expect(linkNamed(graph, "index.md", "notes/alpha").target_path).toBe("notes/alpha.md");
  });

  it("reports a self-link as resolved without making it an edge", () => {
    const graph = buildLinkGraph([note("solo.md", "[[solo]]")]);

    expect(linkNamed(graph, "solo.md", "solo").resolved).toBe(true);
    expect(graph.incoming("solo.md")).toEqual([]);
    expect(graph.neighbors("solo.md", { depth: MAX_LINK_GRAPH_DEPTH })).toEqual([]);
  });

  it("carries both handles on a resolved link, keyed on the server-owned one", () => {
    // INV-2: `id` is frontmatter a note declares about itself. It rides along
    // because citations use it, but `target_path` is what the graph is keyed on.
    const graph = buildLinkGraph([note("index.md", "[[alpha]]"), note("notes/alpha.md", "", { id: "self-declared" })]);

    expect(linkNamed(graph, "index.md", "alpha")).toMatchObject({
      resolved: true,
      target_id: "self-declared",
      target_path: "notes/alpha.md"
    });
  });

  it("keeps both edges when the two syntaxes disagree about the same text", () => {
    // Written in `dir/source.md`, `[[foo]]` names the root-relative `foo.md`
    // while `[x](foo)` names `dir/foo.md`. Deduplicating the raw string before
    // resolving it took whichever leg ran first and dropped the other note's
    // backlink entirely — the missing-edge failure this module exists to remove.
    const graph = buildLinkGraph([note("dir/source.md", "[[foo]]\n[x](foo)"), note("foo.md"), note("dir/foo.md")]);

    const targets = graph
      .outgoing("dir/source.md")
      .filter((link) => link.raw === "foo")
      .map((link) => link.target_path);
    expect(targets).toEqual(["dir/foo.md", "foo.md"]);

    // Both halves: it is the backlinks that were being lost.
    expect(graph.incoming("foo.md").map((node) => node.path)).toEqual(["dir/source.md"]);
    expect(graph.incoming("dir/foo.md").map((node) => node.path)).toEqual(["dir/source.md"]);
  });

  it("collapses the two syntaxes into one entry when they agree", () => {
    // The common case: two entries per link would be noise, not information.
    const graph = buildLinkGraph([note("index.md", "[[notes/alpha]]\n[x](notes/alpha)"), note("notes/alpha.md")]);

    const links = graph.outgoing("index.md").filter((link) => link.raw === "notes/alpha");
    expect(links).toHaveLength(1);
    expect(links[0].target_path).toBe("notes/alpha.md");
  });

  it("matches a decomposed wikilink against a composed filename", () => {
    // Enumerated paths are NFC (`relativeToRoot`); an editor on a decomposing
    // filesystem writes the link decomposed. Markdown links already normalized
    // via resolveRelativeLink, so leaving wikilinks raw made the SAME target
    // resolve one way and miss the other — on macOS, the primary deployment.
    const composed = "ガイド".normalize("NFC");
    const decomposed = "ガイド".normalize("NFD");
    expect(composed).not.toBe(decomposed);

    const graph = buildLinkGraph([
      note("index.md", `[[${decomposed}]]\n[[notes/${decomposed}]]`),
      note(`notes/${composed}.md`)
    ]);

    expect(linkNamed(graph, "index.md", decomposed).target_path).toBe(`notes/${composed}.md`);
    expect(linkNamed(graph, "index.md", `notes/${decomposed}`).target_path).toBe(`notes/${composed}.md`);
  });

  // `title` and `aliases` are never canonicalized upstream, so unlike paths the
  // INDEX side and the LOOKUP side are two separate normalizations — and each
  // only matters when the OTHER side is the decomposed one. Pinning a single
  // direction reaches only one of them: the first draft of this test fixed the
  // title as NFC, so removing the index-side normalize changed nothing and the
  // test stayed green with the guard gone.
  it("normalizes both sides of a frontmatter title comparison", () => {
    const composedLink = buildLinkGraph([
      note("index.md", `[[${"ガイド".normalize("NFC")}]]`),
      note("notes/alpha.md", "", { title: "ガイド".normalize("NFD") })
    ]);
    // Composed link vs decomposed title: only the INDEX-side normalize can meet.
    expect(linkNamed(composedLink, "index.md", "ガイド".normalize("NFC")).candidates?.[0]).toMatchObject({
      path: "notes/alpha.md",
      via: "title"
    });

    const decomposedLink = buildLinkGraph([
      note("index.md", `[[${"ガイド".normalize("NFD")}]]`),
      note("notes/alpha.md", "", { title: "ガイド".normalize("NFC") })
    ]);
    // ...and the mirror image, which only the LOOKUP-side normalize can meet.
    expect(linkNamed(decomposedLink, "index.md", "ガイド".normalize("NFD")).candidates?.[0]).toMatchObject({
      path: "notes/alpha.md",
      via: "title"
    });
  });

  it("normalizes both sides of an alias comparison", () => {
    const composedLink = buildLinkGraph([
      note("index.md", `[[${"ガード".normalize("NFC")}]]`),
      note("notes/beta.md", "", { aliases: ["ガード".normalize("NFD")] })
    ]);
    expect(linkNamed(composedLink, "index.md", "ガード".normalize("NFC")).candidates?.[0]).toMatchObject({
      path: "notes/beta.md",
      via: "alias"
    });

    const decomposedLink = buildLinkGraph([
      note("index.md", `[[${"ガード".normalize("NFD")}]]`),
      note("notes/beta.md", "", { aliases: ["ガード".normalize("NFC")] })
    ]);
    expect(linkNamed(decomposedLink, "index.md", "ガード".normalize("NFD")).candidates?.[0]).toMatchObject({
      path: "notes/beta.md",
      via: "alias"
    });
  });

  it("orders candidates deterministically without implying a ranking", () => {
    // 負債 3: MultiRootStore.listDocuments concatenates per root rather than
    // sorting globally, so nothing downstream may read meaning into position.
    const documents = [note("index.md", "[[note]]"), note("z/note.md"), note("a/note.md"), note("m/note.md")];
    const forward = buildLinkGraph(documents);
    const shuffled = buildLinkGraph([documents[0], documents[2], documents[3], documents[1]]);

    const paths = (graph: ReturnType<typeof buildLinkGraph>) =>
      linkNamed(graph, "index.md", "note").candidates?.map((candidate) => candidate.path);

    expect(paths(forward)).toEqual(["a/note.md", "m/note.md", "z/note.md"]);
    expect(paths(shuffled)).toEqual(paths(forward));
  });

  it("lists one candidate per note, strongest evidence first", () => {
    const graph = buildLinkGraph([
      note("index.md", "[[note]]"),
      // Matches by basename AND by alias; must appear once, labelled basename.
      note("a/note.md", "", { aliases: ["note"] }),
      note("b/note.md")
    ]);

    const candidates = linkNamed(graph, "index.md", "note").candidates ?? [];
    expect(candidates.map((candidate) => candidate.path)).toEqual(["a/note.md", "b/note.md"]);
    expect(candidates.map((candidate) => candidate.via)).toEqual(["basename", "basename"]);
  });
});

describe("linkGraph multi-root scoping", () => {
  const documents = [
    note("reference.md", "[the session](ops:logs/session.md)\n[[session]]\n[[Multi Root Session]]", { root: "vault" }),
    note("logs/session.md", "", { root: "ops", title: "Multi Root Session" })
  ];

  it("resolves the explicit `<root>:` form across roots", () => {
    const graph = buildLinkGraph(documents);

    const link = linkNamed(graph, "vault:reference.md", "ops:logs/session.md");
    expect(link.resolved).toBe(true);
    expect(link.target_path).toBe("ops:logs/session.md");
    expect(graph.incoming("ops:logs/session.md").map((node) => node.path)).toEqual(["vault:reference.md"]);
  });

  it("does not let a bare name or a title reach into another root", () => {
    const graph = buildLinkGraph(documents);

    // Each root is a separate vault: implicit forms stay inside their own.
    expect(linkNamed(graph, "vault:reference.md", "session").resolved).toBe(false);
    expect(linkNamed(graph, "vault:reference.md", "session").candidates).toBeUndefined();
    // ...and a title never resolves anywhere, in root or out of it.
    expect(linkNamed(graph, "vault:reference.md", "Multi Root Session").resolved).toBe(false);
  });

  it("does not let a root name containing the index delimiter collide with another root", () => {
    // Roots "a b" and "a": under a space-separated index key, ("a b", "c/note")
    // and ("a", "b c/note") produce the identical string, so one root's entry
    // silently replaces the other's and a link resolves into the wrong vault.
    const graph = buildLinkGraph([
      note("index.md", "[[c/note]]", { root: "a b" }),
      note("c/note.md", "", { root: "a b" }),
      note("b c/note.md", "", { root: "a" })
    ]);

    expect(linkNamed(graph, "a b:index.md", "c/note").target_path).toBe("a b:c/note.md");
  });

  it("keeps same-root names resolving inside their own root", () => {
    const graph = buildLinkGraph([
      note("reference.md", "[[session]]", { root: "vault" }),
      note("logs/session.md", "", { root: "vault" }),
      note("logs/session.md", "", { root: "ops" })
    ]);

    expect(linkNamed(graph, "vault:reference.md", "session").target_path).toBe("vault:logs/session.md");
  });
});

describe("linkGraph traversal bounds", () => {
  /** origin -> `width` children, each child -> `grandchildren` of its own. */
  function fanOut(width: number, grandchildren: number): MarkdownDocument[] {
    const pad = (value: number) => String(value).padStart(3, "0");
    const documents = [
      note("origin.md", Array.from({ length: width }, (_, index) => `[[child-${pad(index)}]]`).join("\n"))
    ];
    for (let child = 0; child < width; child += 1) {
      documents.push(
        note(
          `child-${pad(child)}.md`,
          Array.from({ length: grandchildren }, (_, index) => `[[gc-${pad(child)}-${pad(index)}]]`).join("\n")
        )
      );
      for (let index = 0; index < grandchildren; index += 1) {
        documents.push(note(`gc-${pad(child)}-${pad(index)}.md`));
      }
    }
    return documents;
  }

  // ── B-1
  it("refuses a depth past the ceiling, and accepts the ones at it", () => {
    const graph = buildLinkGraph(fanOut(2, 1));

    expect(() => graph.neighbors("origin.md", { depth: MAX_LINK_GRAPH_DEPTH + 1 })).toThrow(/depth/);
    expect(() => graph.neighbors("origin.md", { depth: 0 })).toThrow(/depth/);
    expect(() => graph.neighbors("origin.md", { depth: 1.5 })).toThrow(/depth/);
    expect(() => graph.neighbors("origin.md", { depth: MAX_LINK_GRAPH_DEPTH })).not.toThrow();
  });

  it("does not expand at all at the default depth", () => {
    const graph = buildLinkGraph(fanOut(3, 3));

    const related = graph.neighbors("origin.md");
    expect(related.every((node) => node.distance === 1)).toBe(true);
    expect(related).toHaveLength(3);
  });

  // ── B-2. Fan-out is 10, comfortably under its own cap, so this fixture can
  // only ever be truncated by the node cap.
  it("caps the total number of related nodes", () => {
    const graph = buildLinkGraph(fanOut(10, 10));

    const related = graph.neighbors("origin.md", { depth: 2, direction: "out" });
    expect(related).toHaveLength(MAX_RELATED_NODES);
    expect(new Set(related.map((node) => node.path)).size).toBe(MAX_RELATED_NODES);
  });

  // ── B-3. 30 children and no grandchildren: 30 is under the node cap, so
  // only the fan-out cap can bring this down to 20.
  it("caps how many neighbours one node contributes", () => {
    const graph = buildLinkGraph(fanOut(30, 0));

    const related = graph.neighbors("origin.md", { depth: 2, direction: "out" });
    expect(related).toHaveLength(MAX_EXPANSION_FANOUT);
    expect(related.every((node) => node.distance === 1)).toBe(true);
  });

  it("spends the fan-out budget on the most recently modified neighbours", () => {
    const documents = [
      note("origin.md", "[[old]]\n[[new]]"),
      note("old.md", "", { modifiedAt: "2020-01-01T00:00:00.000Z" }),
      note("new.md", "", { modifiedAt: "2026-08-16T00:00:00.000Z" })
    ];

    const related = buildLinkGraph(documents).neighbors("origin.md", { depth: 2, direction: "out", fanoutCap: 1 });
    expect(related.map((node) => node.path)).toEqual(["new.md"]);
  });

  // ── B-4. The depth bound makes the walk terminate whatever happens, so
  // "it finished" proves nothing here. No-revisit is the observable.
  it("never revisits a node in a cycle, the origin least of all", () => {
    const graph = buildLinkGraph([note("a.md", "[[b]]"), note("b.md", "[[c]]"), note("c.md", "[[a]]")]);

    const related = graph.neighbors("a.md", { depth: 2, direction: "both" });
    const paths = related.map((node) => node.path);

    expect(paths).not.toContain("a.md");
    expect(paths).toEqual([...new Set(paths)]);
    expect(paths).toEqual(["b.md", "c.md"]);
  });

  it("reports each node once, at its shortest distance, through a diamond", () => {
    const graph = buildLinkGraph([
      note("origin.md", "[[left]]\n[[right]]\n[[bottom]]"),
      note("left.md", "[[bottom]]"),
      note("right.md", "[[bottom]]"),
      note("bottom.md")
    ]);

    const related = graph.neighbors("origin.md", { depth: 2, direction: "out" });
    const bottom = related.filter((node) => node.path === "bottom.md");
    expect(bottom).toHaveLength(1);
    expect(bottom[0].distance).toBe(1);
  });

  // ── B-5. "Returned but not expanded through" — counting whether the hub
  // comes back would pin the opposite of the rule.
  it("returns a hub as a neighbour but does not expand through it", () => {
    const spokes = HUB_DEGREE_THRESHOLD + 1;
    const documents = [
      note("origin.md", "[[hub]]"),
      note(
        "hub.md",
        Array.from({ length: spokes }, (_, index) => `[[spoke-${String(index).padStart(3, "0")}]]`).join("\n")
      )
    ];
    for (let index = 0; index < spokes; index += 1) {
      documents.push(note(`spoke-${String(index).padStart(3, "0")}.md`));
    }
    const graph = buildLinkGraph(documents);

    const related = graph.neighbors("origin.md", { depth: 2, direction: "out" });
    // The hub itself is genuinely related, so it comes back...
    expect(related.map((node) => node.path)).toEqual(["hub.md"]);
    // ...and nothing behind it does. Both halves, or this pins the wrong rule.
    expect(related.some((node) => node.path.startsWith("spoke-"))).toBe(false);
  });

  it("still answers when the hub itself is what was asked about", () => {
    // Damping exempts the origin: a walk from an index note that returned
    // nothing would be a bound that swallowed the question.
    const spokes = HUB_DEGREE_THRESHOLD + 1;
    const documents = [
      note(
        "hub.md",
        Array.from({ length: spokes }, (_, index) => `[[spoke-${String(index).padStart(3, "0")}]]`).join("\n")
      )
    ];
    for (let index = 0; index < spokes; index += 1) {
      documents.push(note(`spoke-${String(index).padStart(3, "0")}.md`));
    }

    const related = buildLinkGraph(documents).neighbors("hub.md", { depth: 2, direction: "out" });
    expect(related).toHaveLength(MAX_EXPANSION_FANOUT);
  });
});

describe("linkGraph direction and provenance", () => {
  const documents = [
    note("origin.md", "[[downstream]]"),
    note("downstream.md", "[[leaf]]"),
    note("leaf.md"),
    note("upstream.md", "[[origin]]")
  ];

  it("follows only outgoing edges for `out`", () => {
    const related = buildLinkGraph(documents).neighbors("origin.md", { depth: 2, direction: "out" });
    expect(related.map((node) => node.path)).toEqual(["downstream.md", "leaf.md"]);
  });

  it("follows only incoming edges for `in`", () => {
    const related = buildLinkGraph(documents).neighbors("origin.md", { depth: 2, direction: "in" });
    expect(related.map((node) => node.path)).toEqual(["upstream.md"]);
  });

  it("follows both by default", () => {
    const related = buildLinkGraph(documents).neighbors("origin.md", { depth: 2 });
    expect(related.map((node) => node.path)).toEqual(["downstream.md", "upstream.md", "leaf.md"]);
  });

  it("names the node each hop was reached through", () => {
    const related = buildLinkGraph(documents).neighbors("origin.md", { depth: 2, direction: "out" });
    expect(related).toEqual([
      { id: "downstream.md", path: "downstream.md", title: "downstream", distance: 1, via: "origin.md" },
      { id: "leaf.md", path: "leaf.md", title: "leaf", distance: 2, via: "downstream.md" }
    ]);
  });

  it("keeps the two link fields describing the same body", () => {
    // `traceThroughGraph` is handed a document from an earlier `fetch` and a
    // listing from a later full scan. Simulate the note changing in between:
    // the fetched snapshot says `[[old]]`, the listing says `[[new]]`. Reading
    // `outgoing_links` off the fetched body while labelling the listed one let
    // the two arrays describe different text — the one correspondence the
    // response promises. They are now derived from the same place.
    const fetched = note("index.md", "[[old]]");
    const listed = note("index.md", "[[new]]");
    const traced = traceThroughGraph(fetched, [listed, note("old.md"), note("new.md")]);

    expect(traced.outgoing_links).toEqual([...new Set(traced.resolved_outgoing.map((link) => link.raw))].sort());
    expect(traced.outgoing_links).toEqual(["new"]);
  });

  it("reports no links at all when the traced note left the vault mid-call", () => {
    const fetched = note("index.md", "[[old]]");
    const traced = traceThroughGraph(fetched, [note("old.md")]);

    expect(traced.outgoing_links).toEqual([]);
    expect(traced.resolved_outgoing).toEqual([]);
    // The header still describes what was fetched, which is what was asked for.
    expect(traced.document.relativePath).toBe("index.md");
  });

  it("returns nothing for a path the graph does not hold", () => {
    expect(buildLinkGraph(documents).neighbors("absent.md", { depth: 2 })).toEqual([]);
    expect(buildLinkGraph(documents).outgoing("absent.md")).toEqual([]);
    expect(buildLinkGraph(documents).incoming("absent.md")).toEqual([]);
  });
});
