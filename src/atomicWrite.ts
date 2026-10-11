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
 * Three things this costs, stated because replacing a file is not the same
 * operation as writing one:
 *
 *  - **It needs write permission on the DIRECTORY, not just the note.** Writing
 *    in place needed only the file. A vault where a user may edit selected notes
 *    but not add entries to the folder — shared or administratively managed
 *    trees — would now fail, so the failure says which permission is missing
 *    rather than surfacing a bare EACCES. Falling back to an in-place write
 *    there is not on offer: that is the torn-write this exists to prevent, and
 *    a silent fallback is the worst version of it.
 *  - **Ownership must be restored, and failing to restore it is fatal.** The
 *    replacement is a new inode owned by whoever runs this process, so replacing
 *    a note owned by someone else silently transfers it. That is not a
 *    privileged-process-only concern: `rename` needs write permission on the
 *    DIRECTORY, not ownership of the target, so an ordinary account with access
 *    to a shared vault folder can replace another user's note and then find it
 *    cannot `chown` the replacement back. The `chown` is therefore skipped only
 *    when the temp already carries the target's ids, and a failure aborts before
 *    the rename — the note keeps its old contents AND its old owner.
 *    ACLs and extended attributes are NOT preserved; Node cannot read them
 *    portably, so a vault relying on either should stay single-owner.
 *  - **Atomic is not durable.** The bytes are not `fsync`'d before the rename,
 *    so a power loss can still lose the update; what is excluded is a torn file.
 *    The vault's other tmp+rename writers (auditStore / skillStore / oauth
 *    state) make the same trade, so adding fsync is a decision for all four at
 *    once rather than here alone.
 */
export async function replaceFileAtomically(
  targetPath: string,
  content: string,
  original: { mode: number; uid: number; gid: number }
): Promise<void> {
  const temp = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
  // Creating and writing are separate steps so that cleanup only ever removes a
  // file this call made. If the exclusive create fails, nothing here was
  // created — whatever already sits at that name (EEXIST) belongs to someone
  // else and is left alone.
  let created: fs.FileHandle;
  try {
    created = await fs.open(temp, "wx", original.mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new Error(
        "Cannot apply the update: replacing a note atomically requires write permission on the directory that contains it, not only on the note itself.",
        { cause: error }
      );
    }
    throw error;
  }
  try {
    // Until the rename, the temp is touched only through the handle the
    // exclusive create returned — never reopened by path. The write, the ids
    // that decide whether a chown is needed, the chown and the chmod therefore
    // all act on the file this call created, whatever has happened to the name.
    try {
      await created.writeFile(content, "utf8");
      const temporary = await created.stat();
      if (temporary.uid !== original.uid || temporary.gid !== original.gid) {
        // The temp belongs to this process; the target belongs to someone else.
        // Publishing it as-is would hand them a note they no longer own, so a
        // chown that cannot restore the original ids has to stop the operation.
        try {
          await created.chown(original.uid, original.gid);
        } catch (error) {
          throw new Error(
            "Cannot apply the update: the note belongs to a different user or group, and this process cannot restore that ownership on the replacement. Applying anyway would silently transfer the note to this process's owner.",
            { cause: error }
          );
        }
      }
      await created.chmod(original.mode);
    } finally {
      await created.close();
    }
    // The rename (and the cleanup below) still go by name: Node offers no rename
    // or unlink relative to an open descriptor, so whatever sits at the temp's
    // name at that moment is what they act on.
    await fs.rename(temp, targetPath);
  } catch (error) {
    // From the exclusive create onward the temp is this call's own, so any
    // failure here — including a write that failed PART WAY (ENOSPC, EIO) —
    // removes it rather than leaving debris in the user's vault directory.
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
