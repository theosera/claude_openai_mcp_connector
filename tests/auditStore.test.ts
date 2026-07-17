import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditStore } from "../src/auditStore.js";

const sha = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
const EMPTY_SHA = sha("");

describe("AuditStore", () => {
  let root: string;
  let auditRoot: string;
  let store: AuditStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-audit-vault-"));
    auditRoot = path.join(root, "90_Audit", "vault-scan");
    await fs.mkdir(auditRoot, { recursive: true });
    store = new AuditStore({ knowledgeRoot: root, auditSubdir: "90_Audit/vault-scan" });
    await store.init();
  });

  it("creates a report, is idempotent for identical content, and never overwrites", async () => {
    const first = await store.appendAuditReport({ run_id: "2026-07-17T00-00-00Z--run1", content: "# report\n" });
    expect(first).toEqual({ path: "90_Audit/vault-scan/reports/2026-07-17T00-00-00Z--run1.md", created: true });
    const onDisk = path.join(auditRoot, "reports", "2026-07-17T00-00-00Z--run1.md");
    expect(await fs.readFile(onDisk, "utf8")).toBe("# report\n");

    // Identical content for the same run_id → idempotent no-op (still not overwritten).
    const again = await store.appendAuditReport({ run_id: "2026-07-17T00-00-00Z--run1", content: "# report\n" });
    expect(again.created).toBe(false);

    // Different content for an existing run_id → rejected, original bytes survive.
    await expect(
      store.appendAuditReport({ run_id: "2026-07-17T00-00-00Z--run1", content: "# tampered\n" })
    ).rejects.toThrow(/never overwritten/);
    expect(await fs.readFile(onDisk, "utf8")).toBe("# report\n");

    // Assert perms LAST, so no filesystem read follows this stat — avoids a
    // check-then-use (TOCTOU) pattern static analysis flags; the temp vault is
    // single-writer in these tests anyway.
    expect((await fs.stat(onDisk)).mode & 0o777).toBe(0o600);
  });

  it("rejects unsafe run_ids and NUL content", async () => {
    for (const bad of ["../escape", "a/b", "_hidden", ".dot", "-lead", "", "x".repeat(129)]) {
      await expect(store.appendAuditReport({ run_id: bad, content: "x" })).rejects.toThrow(/run_id/i);
    }
    await expect(store.appendAuditReport({ run_id: "ok-run", content: `a${String.fromCharCode(0)}b` })).rejects.toThrow(
      /NUL/
    );
    // The rejected report must not have been created.
    await expect(fs.readdir(path.join(auditRoot, "reports"))).resolves.toEqual([]);
  });

  it("compare-and-swaps the state file (0600), rejecting a stale expected hash", async () => {
    const stateFile = path.join(auditRoot, "state.md");
    const first = await store.compareAndSwapAuditState({ expected_sha256: EMPTY_SHA, new_content: "v1\n" });
    expect(first).toEqual({ path: "90_Audit/vault-scan/state.md", sha256: sha("v1\n") });
    expect(await fs.readFile(stateFile, "utf8")).toBe("v1\n");

    // A now-stale expected hash (still the empty-string hash) is rejected.
    await expect(store.compareAndSwapAuditState({ expected_sha256: EMPTY_SHA, new_content: "v2\n" })).rejects.toThrow(
      /stale/
    );
    expect(await fs.readFile(stateFile, "utf8")).toBe("v1\n");

    // Presenting the current hash advances the state.
    const second = await store.compareAndSwapAuditState({ expected_sha256: sha("v1\n"), new_content: "v2\n" });
    expect(second.sha256).toBe(sha("v2\n"));
    expect(await fs.readFile(stateFile, "utf8")).toBe("v2\n");

    // Assert perms last (see the note in the report test).
    expect((await fs.stat(stateFile)).mode & 0o777).toBe(0o600);
  });

  it("rejects a malformed expected_sha256 and NUL state content", async () => {
    await expect(store.compareAndSwapAuditState({ expected_sha256: "not-a-hash", new_content: "x" })).rejects.toThrow(
      /sha-256/i
    );
    await expect(
      store.compareAndSwapAuditState({ expected_sha256: EMPTY_SHA, new_content: `a${String.fromCharCode(0)}b` })
    ).rejects.toThrow(/NUL/);
  });

  it("serializes concurrent state writes so no update is silently lost", async () => {
    // Both start from the empty state. With the in-process mutex, exactly one
    // wins; the other observes the now-non-empty state and fails the CAS. Without
    // serialization both could read empty and both write (a lost update).
    const results = await Promise.allSettled([
      store.compareAndSwapAuditState({ expected_sha256: EMPTY_SHA, new_content: "A\n" }),
      store.compareAndSwapAuditState({ expected_sha256: EMPTY_SHA, new_content: "B\n" })
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/stale/);
  });

  it("rejects an audit subdir symlink that escapes the root, and a post-init swap", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-audit-outside-"));
    const linkedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-audit-linkroot-"));
    await fs.symlink(outside, path.join(linkedRoot, "linked"));
    const escaping = new AuditStore({ knowledgeRoot: linkedRoot, auditSubdir: "linked" });
    await expect(escaping.init()).rejects.toThrow(/escapes/);

    // Swap the audit dir for an escaping symlink AFTER init → fail closed.
    await fs.rename(auditRoot, `${auditRoot}-orig`);
    await fs.symlink(outside, auditRoot);
    await expect(store.appendAuditReport({ run_id: "run-x", content: "x" })).rejects.toThrow(
      /escapes|changed after initialization/
    );
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
