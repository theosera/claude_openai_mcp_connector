import fs from "node:fs/promises";
import path from "node:path";

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export async function resolveExistingRoot(root: string): Promise<string> {
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error(`KNOWLEDGE_ROOT is not a directory: ${root}`);
  }
  return fs.realpath(root);
}

export function assertRelativePath(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) {
    throw new Error("Path is required.");
  }
  if (path.isAbsolute(cleaned)) {
    throw new Error("Absolute paths are not accepted. Use a vault-relative path or document id.");
  }
  const normalized = path.normalize(cleaned);
  if (normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Path escapes the knowledge root.");
  }
  return normalized;
}

export async function resolveInsideRoot(rootRealPath: string, relativePath: string): Promise<string> {
  const safeRelative = assertRelativePath(relativePath);
  const candidate = path.resolve(rootRealPath, safeRelative);
  const candidateDir = path.dirname(candidate);
  const realDir = await fs.realpath(candidateDir);
  const relativeFromRoot = path.relative(rootRealPath, realDir);

  if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    throw new Error("Path escapes the knowledge root.");
  }

  return path.join(realDir, path.basename(candidate));
}

export function relativeToRoot(rootRealPath: string, absolutePath: string): string {
  const relative = path.relative(rootRealPath, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes the knowledge root.");
  }
  return toPosixPath(relative);
}
