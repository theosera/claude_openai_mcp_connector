import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { parseMarkdown, serializeMarkdown, titleFromMarkdown } from "./frontmatter.js";
import { extractAllLocalLinks } from "./markdownLinks.js";
import { searchDocuments, type SearchFilters } from "./search.js";
import type { AppConfig } from "./config.js";
import type { DocumentMetadata, MarkdownDocument, PlannedPatch, ProjectSummary, SearchResult } from "./types.js";
import { assertRelativePath, relativeToRoot, resolveExistingRoot, resolveInsideRoot, toPosixPath } from "./pathSafety.js";

export class KnowledgeStore {
  private readonly config: AppConfig;
  private rootRealPath?: string;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    this.rootRealPath = await resolveExistingRoot(this.config.knowledgeRoot);
    await fs.mkdir(this.config.patchStateDir, { recursive: true });
  }

  async search(filters: SearchFilters): Promise<SearchResult[]> {
    return searchDocuments(await this.listDocuments(), filters);
  }

  async fetch(idOrPath: string): Promise<MarkdownDocument> {
    const documents = await this.listDocuments();
    const byId = documents.find((document) => document.id === idOrPath);
    if (byId) {
      return byId;
    }

    const normalized = toPosixPath(assertRelativePath(ensureMarkdownExtension(idOrPath)));
    const byPath = documents.find((document) => document.relativePath === normalized);
    if (!byPath) {
      throw new Error(`Document not found: ${idOrPath}`);
    }
    return byPath;
  }

  async listProjects(client?: string, tags?: string[]): Promise<ProjectSummary[]> {
    const tagFilters = (tags ?? []).map((tag) => tag.toLowerCase());
    const grouped = new Map<string, ProjectSummary>();

    for (const document of await this.listDocuments()) {
      if (client && document.frontmatter.client !== client) {
        continue;
      }
      const documentTags = (document.frontmatter.tags ?? []).map((tag) => tag.toLowerCase());
      if (!tagFilters.every((tag) => documentTags.includes(tag))) {
        continue;
      }

      const groupClient = document.frontmatter.client ?? "unknown";
      const project = document.frontmatter.project ?? "uncategorized";
      const key = `${groupClient}\0${project}`;
      const current = grouped.get(key);
      if (!current) {
        grouped.set(key, {
          client: groupClient,
          project,
          count: 1,
          latestModifiedAt: document.stats.modifiedAt
        });
      } else {
        current.count += 1;
        if (document.stats.modifiedAt > current.latestModifiedAt) {
          current.latestModifiedAt = document.stats.modifiedAt;
        }
      }
    }

    return [...grouped.values()].sort((a, b) => a.client.localeCompare(b.client) || a.project.localeCompare(b.project));
  }

  async createDocument(input: {
    client: string;
    project: string;
    title: string;
    body: string;
    tags?: string[];
    source_refs?: string[];
  }): Promise<MarkdownDocument> {
    const metadata: DocumentMetadata = {
      id: crypto.randomUUID(),
      client: input.client,
      project: input.project,
      title: input.title,
      tags: input.tags ?? [],
      source_refs: input.source_refs ?? [],
      updated_at: new Date().toISOString()
    };

    const relativePath = toPosixPath(path.join("projects", slugSegment(input.client), slugSegment(input.project), `${slugSegment(input.title)}.md`));
    const absolutePath = await this.resolveForWrite(relativePath);

    try {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, serializeMarkdown(metadata, input.body), { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Document already exists: ${relativePath}`);
      }
      throw error;
    }

    return this.readDocument(absolutePath);
  }

  async planUpdate(input: {
    id_or_path: string;
    new_body: string;
    frontmatter_patch?: Record<string, unknown>;
    reason: string;
  }): Promise<PlannedPatch> {
    const document = await this.fetch(input.id_or_path);
    const currentRaw = await fs.readFile(document.absolutePath, "utf8");
    const expectedSha = sha256(currentRaw);
    const newMetadata: DocumentMetadata = {
      ...document.frontmatter,
      ...(input.frontmatter_patch ?? {}),
      updated_at: new Date().toISOString()
    };
    const newContent = serializeMarkdown(newMetadata, input.new_body);
    const diff = createTwoFilesPatch(document.relativePath, document.relativePath, currentRaw, newContent, "current", "planned");
    const patch: PlannedPatch = {
      patch_id: crypto.randomUUID(),
      target_path: document.relativePath,
      reason: input.reason,
      expected_sha256: expectedSha,
      created_at: new Date().toISOString(),
      new_content: newContent,
      diff
    };

    await fs.mkdir(this.config.patchStateDir, { recursive: true });
    await fs.writeFile(this.patchPath(patch.patch_id), JSON.stringify(patch, null, 2), "utf8");
    return patch;
  }

  async applyPlannedUpdate(patchId: string): Promise<{ document: MarkdownDocument; diff: string }> {
    const patchRaw = await fs.readFile(this.patchPath(patchId), "utf8");
    const patch = JSON.parse(patchRaw) as PlannedPatch;
    const absolutePath = await this.resolveForExistingRead(patch.target_path);
    const currentRaw = await fs.readFile(absolutePath, "utf8");
    const currentSha = sha256(currentRaw);

    if (currentSha !== patch.expected_sha256) {
      throw new Error("Patch is stale: the target document changed after the plan was created.");
    }

    await fs.writeFile(absolutePath, patch.new_content, "utf8");
    await fs.unlink(this.patchPath(patchId));
    return {
      document: await this.readDocument(absolutePath),
      diff: patch.diff
    };
  }

  async traceSources(idOrPath: string): Promise<{
    document: Pick<MarkdownDocument, "id" | "relativePath" | "title">;
    source_refs: string[];
    outgoing_links: string[];
    backlinks: Array<Pick<MarkdownDocument, "id" | "relativePath" | "title">>;
  }> {
    const document = await this.fetch(idOrPath);
    const documents = await this.listDocuments();
    const linkTargets = new Set([
      document.relativePath,
      document.relativePath.replace(/\.md$/i, ""),
      document.title
    ]);

    const backlinks = documents
      .filter((candidate) => candidate.relativePath !== document.relativePath)
      .filter((candidate) => extractAllLocalLinks(candidate.body).some((link) => linkTargets.has(link) || linkTargets.has(ensureMarkdownExtension(link))))
      .map((candidate) => ({ id: candidate.id, relativePath: candidate.relativePath, title: candidate.title }));

    return {
      document: { id: document.id, relativePath: document.relativePath, title: document.title },
      source_refs: document.frontmatter.source_refs ?? [],
      outgoing_links: extractAllLocalLinks(document.body),
      backlinks
    };
  }

  async listDocuments(): Promise<MarkdownDocument[]> {
    const root = await this.root();
    const files = await walkMarkdownFiles(root);
    const documents = await Promise.all(files.map((file) => this.readDocument(file)));
    return documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private async readDocument(absolutePath: string): Promise<MarkdownDocument> {
    const root = await this.root();
    const realPath = await fs.realpath(absolutePath);
    const relativePath = relativeToRoot(root, realPath);
    const raw = await fs.readFile(realPath, "utf8");
    const stats = await fs.stat(realPath);
    const parsed = parseMarkdown(raw);
    const id = typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id.trim() ? parsed.frontmatter.id.trim() : relativePath;

    return {
      id,
      relativePath,
      absolutePath: realPath,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      title: titleFromMarkdown(relativePath, parsed.frontmatter, parsed.body),
      stats: {
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString()
      }
    };
  }

  private async resolveForExistingRead(relativePath: string): Promise<string> {
    const root = await this.root();
    const absolutePath = await resolveInsideRoot(root, relativePath);
    const realPath = await fs.realpath(absolutePath);
    relativeToRoot(root, realPath);
    return realPath;
  }

  private async resolveForWrite(relativePath: string): Promise<string> {
    const root = await this.root();
    const safeRelative = assertRelativePath(relativePath);
    const parentRelative = path.dirname(safeRelative);
    const parentAbsolute = path.resolve(root, parentRelative);

    await fs.mkdir(parentAbsolute, { recursive: true });
    const realParent = await fs.realpath(parentAbsolute);
    relativeToRoot(root, realParent);
    return path.join(realParent, path.basename(safeRelative));
  }

  private async root(): Promise<string> {
    if (!this.rootRealPath) {
      await this.init();
    }
    return this.rootRealPath!;
  }

  private patchPath(patchId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(patchId)) {
      throw new Error("Invalid patch_id.");
    }
    return path.join(this.config.patchStateDir, `${patchId}.json`);
  }
}

async function walkMarkdownFiles(root: string, current: string = root): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".mcp-state") {
      continue;
    }
    const absolutePath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      const realPath = await fs.realpath(absolutePath);
      relativeToRoot(root, realPath);
      const stat = await fs.stat(realPath);
      if (stat.isDirectory()) {
        files.push(...(await walkMarkdownFiles(root, realPath)));
      } else if (stat.isFile() && realPath.endsWith(".md")) {
        files.push(realPath);
      }
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(root, absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(absolutePath);
    }
  }

  return files;
}

function slugSegment(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function ensureMarkdownExtension(value: string): string {
  return value.endsWith(".md") ? value : `${value}.md`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
