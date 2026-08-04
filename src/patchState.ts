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
 * A tightening that fails (the directory belongs to another user, the platform
 * has no POSIX modes, ...) is reported on stderr and start-up continues:
 * refusing to serve a vault because an existing permission could not be
 * hardened is the worse outcome, and the operator still gets a visible warning.
 */
export async function ensurePatchStateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: PATCH_STATE_DIR_MODE });
  if (process.platform === "win32") {
    return; // POSIX mode bits are not meaningful here.
  }

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if ((stats.mode & 0o077) !== 0) {
      await handle.chmod(PATCH_STATE_DIR_MODE);
    }
  } catch {
    process.stderr.write(
      "[patch-state] could not tighten the patch state directory to owner-only; " +
        "check MCP_PATCH_STATE_DIR ownership and permissions\n"
    );
  } finally {
    await handle?.close();
  }
}
