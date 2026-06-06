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
