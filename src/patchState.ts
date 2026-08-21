import crypto from "node:crypto";
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
 * A stable, opaque identifier for the primary knowledge root.
 *
 * Two callers hash a root with this, and they must not each grow their own
 * hashing rule. `defaultPatchStateDir` gives every vault its own plan directory;
 * `KnowledgeStore.vaultId` / `SkillStore` record a tag in each staged plan so
 * `apply` can refuse a plan staged for a different vault (INV-3).
 *
 * ★ ONE caller uses this directly now: `defaultPatchStateDir`, which runs inside
 * `loadConfig` before anything guarantees the directory exists and so has only a
 * spelling to hash. The plan check needs more than a spelling and goes through
 * `vaultIdentityTag` below. A directory name only has to be stable and
 * per-vault; a plan check has to name the directory the writes land in.
 *
 * The normalisation rules and their reasons, which is why this is a function
 * rather than an inline hash at each site:
 *
 * - **NFC first**, for the reason `src/pathSafety.ts` normalises: macOS hands
 *   back NFD for non-ASCII components, so one vault reaches us spelled two ways
 *   depending on whether the value was typed, pasted from Finder, or completed
 *   by a shell. Both callers need the same spelling to produce the same tag.
 * - **Case is NOT folded**, because folding is wrong on a case-sensitive
 *   filesystem — it would merge two genuinely different vaults into one tag,
 *   and for the plan check that means accepting a cross-vault apply.
 * - **Symlinks are resolved by the CALLER, not here**, because only the caller
 *   knows whether it can. This function hashes the string it is given.
 *
 * Case folding and symlink resolution are not two versions of one choice, and an
 * earlier revision of this comment treated them as one — it said both "widen
 * what counts as the same path" and that both therefore fail closed. Folding
 * case does merge two genuinely different vaults into one tag, so it is refused
 * here. Resolving symlinks does the OPPOSITE: it keeps two spellings of one
 * vault together, and it separates one spelling whose target has been moved to
 * another vault. Leaving them unresolved is what fails OPEN, because the tag
 * then follows the operator's spelling rather than the directory the writes land
 * in. Raised as a P1 by Codex on #142; the plan check resolves before hashing.
 *
 * Truncated to 64 bits: this is an equality check between values this server
 * wrote, not a signature. A collision needs two distinct root paths whose
 * SHA-256 shares a 16-hex prefix, and finding one is not a capability the threat
 * model grants anybody — the attacker in scope is a second server started
 * against a different vault with a shared `MCP_PATCH_STATE_DIR`, which is a
 * misconfiguration, not a chosen-prefix search.
 */
export function vaultTag(primaryRoot: string): string {
  return crypto.createHash("sha256").update(primaryRoot.normalize("NFC")).digest("hex").slice(0, 16);
}

/**
 * The identity a staged plan records, and the one `apply` re-checks (INV-3).
 *
 * A pathname is not an identity. Resolving symlinks fixed the case where one
 * spelling was pointed at a second vault, but left the case where the DIRECTORY
 * at a fixed path is replaced — a restore, a redeploy, `mv vault vault.old &&
 * mv restored vault`. The resolved string is identical across that, and so is
 * the default patch-state directory, so a fresh store accepted plans staged for
 * the directory that used to be there. **A planned create is the sharp end: it
 * has no stale-content check to fall back on**, so the old plan simply publishes
 * into the replacement. Raised as a second P1 by Codex on #142.
 *
 * So the tag covers both what the directory IS — `(dev, ino)`, the same identity
 * `assertOutsideKnowledgeRoots` compares in `config.ts` rather than trusting
 * `path.relative` — and the resolved path it was reached BY. Either one changing
 * refuses the plan. That is one rule with no case analysis, and it fails closed
 * in every direction.
 *
 * ⚠️ **State the cost rather than discovering it in an incident.** `(dev, ino)`
 * is stable for a living directory and NOT stable across a restore from backup,
 * a copy, or a remount that renumbers the device — and including the path means
 * renaming the vault refuses too, even though the inode is the same. In all of
 * those the vault is arguably "the same vault" and its staged plans are refused
 * anyway. That is the direction to be wrong in: a plan is cheap to stage again,
 * and the alternative is a write landing in a vault nobody approved it for. The
 * refusal message says to re-plan.
 *
 * Stat'ed per call rather than cached at `init`, so a directory swapped under a
 * running server is caught at the apply rather than at the next restart.
 */
export async function vaultIdentityTag(resolvedRoot: string): Promise<string> {
  const stats = await fs.stat(resolvedRoot);
  return crypto
    .createHash("sha256")
    .update(`${resolvedRoot.normalize("NFC")}\0${stats.dev}\0${stats.ino}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * What a plan id may look like. The single definition — both stores validate
 * against this before building a path, and the sweep below recognises a file by
 * it. Two copies of a naming rule is how the sweep and the writers drift apart.
 *
 * ★ The UUID SHAPE, not "36 characters drawn from hex and dashes", which is what
 * this was. The loose form predates the sweep and was harmless while it only
 * validated an incoming patch_id — the id still had to name a real staged file.
 * Sharing it with the sweep gave it a second job it was never accurate enough
 * for: deciding what may be DELETED. Measured, `"------------------------------------.json"`
 * — thirty-six dashes — classified as a plan.
 *
 * Every id this server produces comes from crypto.randomUUID(), and the Skill
 * plan schema already validates `z.string().uuid()`, so this rejects nothing a
 * writer can emit; it only stops the sweep from claiming a neighbouring file
 * that happens to fall inside the old character class. Narrowing what an
 * untrusted patch_id may look like is a free improvement in the same direction.
 */
export const PATCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Skill plans are named apart from document plans so the two cannot collide. */
export const SKILL_PLAN_PREFIX = "skill-create-";

/**
 * Is this directory entry one of OUR plan files?
 *
 * The sweep used to ask only whether the name ended in `.json`, while the
 * comment above it — and its test — said it was "scoped to plan JSON". Those are
 * not the same claim, and the gap is not academic: `MCP_PATCH_STATE_DIR` and
 * `MCP_OAUTH_STATE_FILE` are both operator-chosen paths with no rule keeping
 * them apart, so pointing the second inside the first meant the sweep deleted
 * `oauth-state.json` — every registered client and every live token, on the
 * seventh day. The test never noticed because the file it planted to prove
 * "we leave other files alone" was `notes.txt`, which the extension check
 * already excluded. It tested the half that worked.
 *
 * ★ Matching bare UUIDs is NOT enough, and getting this wrong would have
 * silently undone this PR's own design point. Document plans are `<uuid>.json`,
 * but Skill plans are `skill-create-<uuid>.json` — and skillStore is precisely
 * the writer the sweep was extended to reach. A UUID-only rule would have
 * dropped it straight back out while every test stayed green.
 */
export function isPlanFileName(entry: string): boolean {
  if (!entry.endsWith(".json")) {
    return false;
  }
  const stem = entry.slice(0, -".json".length);
  const id = stem.startsWith(SKILL_PLAN_PREFIX) ? stem.slice(SKILL_PLAN_PREFIX.length) : stem;
  return PATCH_ID_PATTERN.test(id);
}

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
    // Swept here too, and this branch is the asymmetric one worth naming: the
    // O_NOFOLLOW validation below does not run, so unlike every other platform
    // the deletion is not preceded by a refusal to follow a linked state
    // directory. Kept anyway, because the alternative is that Windows never
    // expires a plan at all — the defect this exists to close. It does not
    // widen anything either: the `mkdir` on the line above already follows such
    // a link, so plans were being WRITTEN through it before the sweep existed.
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
    // Sweeps before returning, for the same reason the win32 branch does: this
    // is a WARN-and-continue path, so the server goes on staging plans here and
    // would otherwise be the one configuration that never expires any of them.
    // The refusal above has already run, so a symlinked directory never reaches
    // this line — which is the whole ordering rule, applied to this exit too.
    //
    // Missing it was the third exit path in one function to be treated
    // differently by a rule meant to cover all of them. Any `return` added below
    // needs the same line; there is deliberately no shared wrapper, because a
    // wrapper would also have to run on the refusal, which must NOT sweep.
    await prunePatchState(dir);
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
 * "Plan files" per isPlanFileName, which is the same rule the two stores build
 * their paths from — not "anything ending in .json", which is what this asked
 * before and which reached whatever else an operator had put in the directory.
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
    if (!isPlanFileName(entry)) {
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
