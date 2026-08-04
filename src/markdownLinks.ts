/**
 * Both extractors below scan with forward-only cursors instead of a regular
 * expression, and deliberately reproduce the patterns they replace character for
 * character:
 *
 *   wiki:     /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g
 *   markdown: /\[[^\]]+\]\(([^)]+)\)/g
 *
 * Those patterns are quadratic on untrusted bodies. Their negated classes accept
 * the pattern's own opening delimiters, so a body of `[x](` — or of unterminated
 * `[` — makes the engine walk the rest of the body at every `[` and then throw
 * the work away, and `traceSources` runs them over *every* document in the vault
 * on every call: one imported web clipping of ~1 MiB blocks the single-threaded
 * server for minutes.
 *
 * A hand-written scan rather than a tighter pattern, because neither alternative
 * works here. Excluding `[` from the classes would change which links are found
 * (`[a[b](t)` and `[[[[a]]` match today, and recall is load-bearing for
 * backlinks), and JavaScript has no atomic groups or possessive quantifiers to
 * pin the classes down — even if it did, the engine would still restart at every
 * `[` and re-walk the tail, which is where most of the quadratic cost lives.
 * The scan below never rewinds, so it is linear in the body length.
 *
 * The accepted language and the captured text are unchanged; the differential
 * test in `tests/markdownLinks.test.ts` compares this against the original
 * patterns over a corpus of ordinary and awkward bodies.
 */

/**
 * First index at or after `from` holding one of `stops`, or `-1` when the rest
 * of the body holds none.
 *
 * The cursor never rewinds: every call site below asks about positions that only
 * move forward, so a remembered hit stays valid until the request passes it and
 * a `-1` is final. Each character is therefore inspected at most once per stop
 * character over a whole scan. (A caller that did move backwards would still get
 * the right answer — just by re-scanning.)
 */
function createStopFinder(body: string, stops: readonly string[]): (from: number) => number {
  const cache = stops.map(() => ({ searchedFrom: -1, hit: -1 }));

  return (from: number): number => {
    let nearest = -1;
    for (let index = 0; index < stops.length; index += 1) {
      const entry = cache[index];
      const reusable = entry.searchedFrom >= 0 && from >= entry.searchedFrom && (entry.hit === -1 || entry.hit >= from);
      if (!reusable) {
        entry.hit = body.indexOf(stops[index], from);
        entry.searchedFrom = from;
      }
      if (entry.hit !== -1 && (nearest === -1 || entry.hit < nearest)) {
        nearest = entry.hit;
      }
    }
    return nearest;
  };
}

export function extractWikiLinks(body: string): string[] {
  const links = new Set<string>();
  const nextClose = createStopFinder(body, ["]"]);
  const nextNameStop = createStopFinder(body, ["]", "|", "#"]);
  const nextAnchorStop = createStopFinder(body, ["]", "|"]);

  let cursor = 0;
  while (cursor < body.length) {
    const open = body.indexOf("[[", cursor);
    if (open === -1) {
      break;
    }

    // None of the three classes can cross a `]`, so a match opened here can only
    // ever end at the first `]` at or after the name — and if there is none left
    // in the body, no later `[[` can close either.
    const nameStart = open + 2;
    const close = nextClose(nameStart);
    if (close === -1) {
      break;
    }

    // A failed attempt resumes one character on, exactly as the `/g` regex did.
    cursor = open + 1;
    if (body[close + 1] !== "]") {
      continue;
    }

    const nameEnd = nextNameStop(nameStart); // never past `close`: `]` is a stop
    if (nameEnd === nameStart) {
      continue; // `[^\]|#]+` needs at least one character
    }

    // Whatever follows the name must be filled exactly by the optional
    // `#anchor` and `|alias` groups, each of which needs content of its own.
    let rest = nameEnd;
    if (body[rest] === "#") {
      const anchorEnd = nextAnchorStop(rest + 1); // never past `close`
      if (anchorEnd === rest + 1) {
        continue; // `#` with an empty anchor
      }
      rest = anchorEnd;
    }
    if (close === rest + 1) {
      continue; // `|` with an empty alias (`rest` here is always that `|`)
    }

    links.add(body.slice(nameStart, nameEnd).trim());
    cursor = close + 2;
  }

  return [...links].sort();
}

export function extractMarkdownLinks(body: string): string[] {
  const links = new Set<string>();
  const nextTextEnd = createStopFinder(body, ["]"]);
  const nextTargetEnd = createStopFinder(body, [")"]);

  let cursor = 0;
  while (cursor < body.length) {
    const open = body.indexOf("[", cursor);
    if (open === -1) {
      break;
    }

    // `[^\]]+` cannot cross a `]`, so the link text always ends at the first one
    // after `[`; with none left in the body, no later `[` can match either.
    const textEnd = nextTextEnd(open + 1);
    if (textEnd === -1) {
      break;
    }

    cursor = open + 1;
    if (textEnd === open + 1 || body[textEnd + 1] !== "(") {
      continue;
    }

    // Likewise `[^)]+` ends at the first `)`, and must be non-empty.
    const targetStart = textEnd + 2;
    const targetEnd = nextTargetEnd(targetStart);
    if (targetEnd === -1) {
      break;
    }
    if (targetEnd === targetStart) {
      continue;
    }

    const target = body.slice(targetStart, targetEnd).trim();
    if (target && !target.includes("://") && !target.startsWith("#")) {
      links.add(target);
    }
    cursor = targetEnd + 1;
  }

  return [...links].sort();
}

export function extractAllLocalLinks(body: string): string[] {
  return [...new Set([...extractWikiLinks(body), ...extractMarkdownLinks(body)])].sort();
}

/**
 * Resolve a Markdown link against the directory of the note that contains it —
 * `[plan](../../claude/planning/connector-plan.md)` written in
 * `projects/chatgpt/research/shared-search.md` refers to
 * `projects/claude/planning/connector-plan.md`, which literal string matching
 * never sees. Returns a vault-relative posix path, or `null` when the link is
 * not a containable relative path.
 *
 * Pure string math: the result is only ever compared against paths of documents
 * the store already enumerated (each of which passed the INV-1 guard chain), and
 * is never handed to `fs`. A link that climbs out of the root still resolves to
 * `null` here so it cannot masquerade as an in-vault target.
 */
export function resolveRelativeLink(link: string, fromRelativePath: string): string | null {
  const withoutFragment = link.split("#")[0].split("?")[0].trim();
  if (!withoutFragment || withoutFragment.startsWith("/") || withoutFragment.includes("\0")) {
    return null;
  }

  // Obsidian/editors percent-encode spaces in links; decode for comparison only.
  let target = withoutFragment;
  try {
    target = decodeURIComponent(withoutFragment);
  } catch {
    // Malformed escape (e.g. `%ZZ`): compare the raw form instead of failing.
  }

  const fromDirectory = fromRelativePath.includes("/")
    ? fromRelativePath.slice(0, fromRelativePath.lastIndexOf("/"))
    : "";
  const segments = `${fromDirectory}/${target}`.split("/");
  const stack: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (stack.length === 0) {
        return null; // escapes the vault root
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }

  // Enumerated document paths are canonicalized to NFC (`relativeToRoot`), and a
  // link may spell a non-ASCII filename decomposed — an editor on a decomposing
  // filesystem writes it that way. Canonicalize to the same form or the strict
  // equality the callers use misses a canonically identical name. NFC, not the
  // search path's NFKC: half-width and full-width names are genuinely different
  // files, and this value is compared against real paths.
  return stack.length > 0 ? stack.join("/").normalize("NFC") : null;
}
