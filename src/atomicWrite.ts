import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Atomically replace the contents of an EXISTING file.
 *
 * `applyPlannedUpdate` is the only write in this codebase that overwrites a
 * user's note, and it used to `writeFile` straight over the target. That
 * truncates first: a crash, a full disk, or a kill between the truncate and the
 * final byte leaves the note half-written, and the vault keeps no second copy to
 * recover from. Writing a private temp file in the SAME directory and renaming
 * it over the target makes the swap all-or-nothing — a concurrent reader sees
 * either the whole old file or the whole new one, never a prefix.
 *
 * Three details are load-bearing:
 *
 *  - The temp lives in the target's own directory, because `rename` is only
 *    atomic within a single filesystem; `os.tmpdir()` is frequently a different
 *    mount, which would silently degrade this back to a copy.
 *  - The temp name is dot-prefixed and does NOT end in `.md`, so a hard kill
 *    leaves behind a file that `walkMarkdownFiles` will not index as a note and
 *    that vault UIs hide by default.
 *  - The target's permission bits are applied twice, and the order matters. The
 *    `mode` open flag alone cannot reproduce them (the process umask subtracts
 *    from it) and `chmod` alone would leave the note's bytes sitting in a
 *    default-mode (typically world-readable) file for the length of the write —
 *    a private 0600 note must not be briefly readable by other local accounts.
 *    So: create no wider than the target, then chmod to exactly the target.
 *
 * NOTE — atomic is not durable. The bytes are not `fsync`'d before the rename,
 * so a power loss can still lose the update; what is excluded is a torn file.
 * The vault's other tmp+rename writers (auditStore / skillStore / oauth state)
 * make the same trade, so adding fsync is a decision to take for all four at
 * once rather than here alone.
 */
export async function replaceFileAtomically(targetPath: string, content: string, mode: number): Promise<void> {
  const temp = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp, content, { encoding: "utf8", flag: "wx", mode });
  try {
    await fs.chmod(temp, mode);
    await fs.rename(temp, targetPath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
