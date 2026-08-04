import fs from "node:fs/promises";

// Two-step plan files are the one place vault plaintext is copied outside the
// vault: a planned update carries the pre-edit text (inside `diff`) and the
// full proposed text (`new_content`), a planned create carries the whole new
// body, and plans survive on disk until they are applied. They therefore stay
// owner-only, matching the Skill / audit / OAuth state stores.
export const PATCH_STATE_DIR_MODE = 0o700;
export const PATCH_STATE_FILE_MODE = 0o600;

/**
 * Creates the configured patch state directory owner-only, and tightens one
 * that already exists. Both halves are needed: `fs.mkdir` never chmods a
 * directory that is already there, so a directory left group/other-readable by
 * an earlier version (or by whichever store happened to create it first) would
 * otherwise keep those bits forever.
 *
 * Deliberately narrow: only the configured directory itself — never its
 * parents, never recursive, and never through a symlink. The mode is read and
 * changed through one file descriptor opened with `O_NOFOLLOW`, so the check
 * and the chmod cannot be split by a swapped path and we can never
 * re-permission something outside the configured directory.
 *
 * A tightening that FAILS is reported on stderr and start-up continues:
 * refusing to serve a vault because an existing permission could not be
 * hardened is the worse outcome, and the operator still gets a visible warning.
 * That reasoning rests on the 0600 file mode still applying, so it does not
 * extend to a symlinked or non-directory target — see below, which throws.
 */
export async function ensurePatchStateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: PATCH_STATE_DIR_MODE });
  if (process.platform === "win32") {
    return; // POSIX mode bits are not meaningful here.
  }

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    // O_NOFOLLOW turns a symlinked state directory into ELOOP/ENOTDIR (which of
    // the two is platform-dependent), and `fs.mkdir(recursive)` happily follows
    // such a link, so this is the only place it is detected.
    //
    // Unlike a chmod failure this is NOT a missing defence-in-depth layer, so it
    // must not be warned past: every plan file would then be written through the
    // link into a directory another account owns, and the 0600 file mode does
    // not help there — unlink and rename are governed by the DIRECTORY's
    // permissions, so that account can still swap a staged plan for one carrying
    // different content and a matching content_sha256, which is exactly the
    // approve-this-diff guarantee (INV-3) the two-step write exists to provide.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new Error("MCP_PATCH_STATE_DIR must be a real directory, not a symbolic link.", { cause: error });
    }
    process.stderr.write(
      "[patch-state] could not tighten the patch state directory to owner-only; " +
        "check MCP_PATCH_STATE_DIR ownership and permissions\n"
    );
    return;
  }

  try {
    const stats = await handle.stat();
    // Compare the whole permission triad, not just the group/other bits: a
    // directory left at 0500 clears `& 0o077` yet denies the owner the write
    // permission every plan write needs, so it has to be corrected too.
    if ((stats.mode & 0o777) !== PATCH_STATE_DIR_MODE) {
      await handle.chmod(PATCH_STATE_DIR_MODE);
    }
  } catch {
    process.stderr.write(
      "[patch-state] could not tighten the patch state directory to owner-only; " +
        "check MCP_PATCH_STATE_DIR ownership and permissions\n"
    );
  } finally {
    await handle.close();
  }
}
