import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { relativeToRoot, resolveExistingRoot, resolveInsideRoot, toPosixPath } from "./pathSafety.js";

// A `run_id` becomes a filename (`reports/<run_id>.md`), so constrain it to a
// safe, single-segment token: must start with an alphanumeric (no leading `.`,
// `_`, or `-`), then alphanumerics / `.` / `_` / `-` only. This forbids `/`,
// `..`, NUL, and any path separator, so a run_id can never traverse out of the
// reports directory nor collide with the reserved state file (which lives in a
// different directory anyway).
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_STATE_BYTES = 256 * 1024;
const REPORTS_SUBDIR = "reports";
const STATE_FILENAME = "state.md";

export interface AuditStoreConfig {
  /** Absolute path to the primary (writable) knowledge root. */
  knowledgeRoot: string;
  /** Vault-relative directory that holds audit output (MCP_AUDIT_SUBDIR). */
  auditSubdir: string;
}

export interface AppendAuditReportInput {
  run_id: string;
  content: string;
}

export interface CompareAndSwapAuditStateInput {
  expected_sha256: string;
  new_content: string;
}

/**
 * A constrained, append-only + compare-and-swap write surface scoped to a
 * single vault subtree (`MCP_AUDIT_SUBDIR`), for an unattended scanner to persist
 * audit reports and scan state WITHOUT holding the general document-write tools.
 *
 * Security posture (INV-9 — audit-trail integrity):
 *  - All writes are contained inside the configured subtree via the same
 *    path-safety chain as the rest of the server (realpath + relativeToRoot).
 *  - Reports are create-only: an existing report is never overwritten (identical
 *    content is an idempotent no-op; different content is rejected).
 *  - State updates are compare-and-swap: the caller must present the sha256 of
 *    the version it read, or the swap is rejected as stale.
 *  - Every operation is serialized through an in-process mutex, because MCP can
 *    pipeline concurrent tool calls within one session and the unattended
 *    scanner has no human-approval gap to prevent an interleaved read/modify.
 *  - The general document-write tools are separately forbidden from writing into
 *    this subtree (see KnowledgeStore INV-9 reservation), so a compromised
 *    interactive session cannot forge or clobber audit files.
 */
export class AuditStore {
  private readonly config: AuditStoreConfig;
  private rootRealPath?: string;
  private auditRootRealPath?: string;
  private reportsRealPath?: string;
  // Promise-chain serializer: each op awaits the previous one settling. Errors
  // are swallowed on the chain so one failure never wedges later operations.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(config: AuditStoreConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    this.rootRealPath = await resolveExistingRoot(this.config.knowledgeRoot);
    const candidate = await resolveInsideRoot(this.rootRealPath, this.config.auditSubdir);
    const stat = await fs.stat(candidate);
    if (!stat.isDirectory()) {
      throw new Error("MCP_AUDIT_SUBDIR is not a directory.");
    }
    this.auditRootRealPath = await fs.realpath(candidate);
    relativeToRoot(this.rootRealPath, this.auditRootRealPath);

    // Disjointness must hold on the RESOLVED path, not just the configured string
    // (config.ts checks the latter). A symlinked MCP_AUDIT_SUBDIR could otherwise
    // resolve into projects/ (the document-create root), which would BOTH let the
    // audit tools write there AND make INV-9 reject every legitimate project
    // create/update. Fail closed at boot.
    const projectsReal = await realpathOrUndefined(path.join(this.rootRealPath, "projects"));
    if (
      projectsReal &&
      (isSameOrInside(projectsReal, this.auditRootRealPath) || isSameOrInside(this.auditRootRealPath, projectsReal))
    ) {
      throw new Error(
        "MCP_AUDIT_SUBDIR resolves inside (or contains) the projects/ document-create root; they must be disjoint."
      );
    }

    // reports/ MUST be a real directory: a symlinked reports/ would let a later
    // resolve follow it and land a report (e.g. run_id "state") outside the
    // reports directory, breaking the report/state separation.
    const reportsPath = path.join(this.auditRootRealPath, REPORTS_SUBDIR);
    await assertNotSymlink(reportsPath, "reports/ inside MCP_AUDIT_SUBDIR");
    await fs.mkdir(reportsPath, { recursive: true, mode: 0o700 });
    this.reportsRealPath = await fs.realpath(reportsPath);
    relativeToRoot(this.rootRealPath, this.reportsRealPath);
  }

  /**
   * Create an audit report at `reports/<run_id>.md`. Never overwrites: identical
   * content for an existing run_id is an idempotent success; different content is
   * rejected. Returns the vault-relative path and whether a new file was written.
   */
  async appendAuditReport(input: AppendAuditReportInput): Promise<{ path: string; created: boolean }> {
    return this.serialize(async () => {
      if (typeof input.run_id !== "string" || !RUN_ID_PATTERN.test(input.run_id)) {
        throw new Error("Invalid run_id. Use a single token of letters/digits/._- starting with a letter or digit.");
      }
      const content = assertWritableText(input.content, MAX_REPORT_BYTES, "audit report");
      const reportsRoot = await this.reportsRoot();
      // run_id is a strict single-segment token (no separators, validated above)
      // and reportsRoot is a re-validated REAL directory, so the target stays
      // inside reports/ without following any symlink.
      const target = path.join(reportsRoot, `${input.run_id}.md`);
      const relativePath = toPosixPath(relativeToRoot(this.rootRealPath!, target));
      try {
        await fs.writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return { path: relativePath, created: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          const existing = await fs.readFile(target, "utf8");
          if (existing === content) {
            // Idempotent re-submission of the same run: succeed without touching
            // the file (create-only preserved).
            return { path: relativePath, created: false };
          }
          throw new Error(
            "An audit report already exists for this run_id with different content; audit reports are never overwritten.",
            { cause: error }
          );
        }
        throw error;
      }
    });
  }

  /**
   * Compare-and-swap the single reserved state file (`state.md`). The caller
   * presents the sha256 of the version it read (sha256("") for a first write);
   * the swap is applied atomically only if it still matches, else it is rejected
   * as stale. Returns the vault-relative path and the new content's sha256.
   */
  async compareAndSwapAuditState(input: CompareAndSwapAuditStateInput): Promise<{ path: string; sha256: string }> {
    return this.serialize(async () => {
      if (typeof input.expected_sha256 !== "string" || !SHA256_HEX.test(input.expected_sha256)) {
        throw new Error(
          "expected_sha256 must be a 64-character hex SHA-256 (use the sha256 of the empty string for a first write)."
        );
      }
      const content = assertWritableText(input.new_content, MAX_STATE_BYTES, "audit state");
      const auditRoot = await this.auditRoot();
      const target = path.join(auditRoot, STATE_FILENAME);
      // A symlinked state.md would let the read below follow it outside the
      // subtree; keep the state file a real file confined to the audit root.
      await assertNotSymlink(target, "state.md inside MCP_AUDIT_SUBDIR");

      let current = "";
      try {
        current = await fs.readFile(target, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (sha256(current) !== input.expected_sha256.toLowerCase()) {
        throw new Error("Audit state is stale: the state file changed since it was read (compare-and-swap failed).");
      }

      // Atomic same-directory replace: write a private temp then rename over the
      // target. rename is atomic and clobber-on-update is the desired behavior
      // for a state file (unlike create-only reports).
      const temp = path.join(auditRoot, `.state-${crypto.randomUUID()}.tmp`);
      await fs.writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        await fs.rename(temp, target);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      return { path: toPosixPath(relativeToRoot(this.rootRealPath!, target)), sha256: sha256(content) };
    });
  }

  /** Re-resolve + re-validate the audit root on every op (init-time swap guard). */
  private async auditRoot(): Promise<string> {
    if (!this.auditRootRealPath || !this.rootRealPath) {
      await this.init();
    }
    const candidate = await resolveInsideRoot(this.rootRealPath!, this.config.auditSubdir);
    const currentRealPath = await fs.realpath(candidate);
    relativeToRoot(this.rootRealPath!, currentRealPath);
    if (currentRealPath !== this.auditRootRealPath) {
      throw new Error("MCP_AUDIT_SUBDIR changed after initialization.");
    }
    return this.auditRootRealPath!;
  }

  /** Re-resolve + re-validate the reports/ directory on every append (swap guard). */
  private async reportsRoot(): Promise<string> {
    const auditRoot = await this.auditRoot();
    const candidate = path.join(auditRoot, REPORTS_SUBDIR);
    await assertNotSymlink(candidate, "reports/ inside MCP_AUDIT_SUBDIR");
    const currentRealPath = await fs.realpath(candidate);
    relativeToRoot(this.rootRealPath!, currentRealPath);
    if (currentRealPath !== this.reportsRealPath) {
      throw new Error("reports/ changed after initialization.");
    }
    return currentRealPath;
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/** Reject a path that exists as a symlink; a missing path (ENOENT) is fine. */
async function assertNotSymlink(target: string, label: string): Promise<void> {
  const info = await fs.lstat(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (info?.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory or file, not a symlink.`);
  }
}

/** Realpath of `target`, or undefined when it does not exist. */
async function realpathOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** True when absolute `child` is the same as, or nested inside, `parent`. */
function isSameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertWritableText(value: string, maxBytes: number, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`The ${label} must be text without NUL bytes.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`The ${label} is too large (max ${maxBytes} bytes).`);
  }
  return value;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
