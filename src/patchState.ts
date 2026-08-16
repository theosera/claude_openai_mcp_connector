import fs from "node:fs/promises";
import path from "node:path";

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
    await prunePatchState(dir);
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

  // ★ AFTER the O_NOFOLLOW validation above, never before it.
  //
  // Swept here rather than from each plan writer because this is the one
  // function every plan-staging store already calls, so a writer added later
  // inherits the sweep instead of needing someone to remember it. But placing it
  // at the TOP — which is where it went first — made a symlinked
  // MCP_PATCH_STATE_DIR destructive: the sweep followed the link and deleted
  // `.json` files from whatever it pointed at, and only then did the check
  // below refuse to start. A configuration that used to fail closed without
  // touching anything would have deleted files in another directory first.
  //
  // Deleting is the one operation here that cannot be taken back, so it goes
  // last, after every reason to refuse has been evaluated.
  //
  // What this does NOT give you: a timer. The sweep fires at start-up and again
  // whenever a plan is staged, so a server that stays up and stages nothing more
  // never sweeps again — the plan staged just before the vault went quiet can
  // outlive PLAN_MAX_AGE_MS by however long that quiet lasts. Bounding
  // accumulation is what this is for, and accumulation only happens on the path
  // that is already sweeping; an exact expiry deadline would need an interval,
  // which is a heavier thing to own than the problem justifies.
  await prunePatchState(dir);
}

/**
 * How long an unapplied plan stays on disk.
 *
 * A plan is only deleted when it is APPLIED, so one the user declined — or one
 * whose conversation simply ended — used to sit there for the life of the
 * machine, holding the pre-edit text and the full proposed text of a note
 * outside the vault. There is no MCP tool to discard one either: the only way to
 * remove a plan was to perform the very operation that was refused.
 *
 * Seven days rather than something tight: a plan is meant to be approved inside
 * the conversation that produced it, but "planned on Friday, approved on Monday"
 * is a real workflow and expiring that would be a worse failure than keeping the
 * file. Nothing depends on the exact value — this bounds accumulation, it is not
 * a security boundary. The window a stale plan could once use to carry content
 * past a newer guard is closed at apply, where the checks belong.
 */
export const PLAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete plan files older than PLAN_MAX_AGE_MS.
 *
 * Age comes from the file's own mtime. Content freshness must never rest on
 * mtime — a checkout or a copy moves it while the bytes stay old — but nothing
 * here reads the plan: this asks how long the FILE has existed, and these files
 * are written once, never modified, and never checked into anything.
 *
 * Failure is not fatal in either direction. A directory that cannot be listed,
 * or a file that vanished between the listing and the unlink (two servers
 * sharing a state directory), leaves the sweep incomplete and the server
 * running. Refusing to serve a vault because old plans could not be tidied would
 * be the wrong trade — the same reasoning the chmod above already applies.
 */
export async function prunePatchState(dir: string, now: number = Date.now()): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const file = path.join(dir, entry);
    try {
      const stats = await fs.stat(file);
      if (now - stats.mtimeMs > PLAN_MAX_AGE_MS) {
        await fs.unlink(file);
        removed += 1;
      }
    } catch {
      // Gone already, or not ours to remove. Either way the next sweep will see
      // the truth; nothing here is worth failing a start-up over.
    }
  }
  return removed;
}
