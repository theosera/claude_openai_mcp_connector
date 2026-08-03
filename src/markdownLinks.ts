export function extractWikiLinks(body: string): string[] {
  const links = new Set<string>();
  const wikiLinkPattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  for (const match of body.matchAll(wikiLinkPattern)) {
    links.add(match[1].trim());
  }
  return [...links].sort();
}

export function extractMarkdownLinks(body: string): string[] {
  const links = new Set<string>();
  const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of body.matchAll(markdownLinkPattern)) {
    const target = match[1].trim();
    if (target && !target.includes("://") && !target.startsWith("#")) {
      links.add(target);
    }
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

  return stack.length > 0 ? stack.join("/") : null;
}
