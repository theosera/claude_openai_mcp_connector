# Dependency policy

What to do when an advisory or a dependency-update PR appears. `CLAUDE.md` states
the posture — two audit steps, only the production one blocking — and
`.github/workflows/node.js.yml` is the canon for what CI actually runs. This file
is the decision tree, and the traps that produced it.

## Why this file exists

`GHSA-5p4m-2wfm-xmqj` (quadratic `!!omap` in `js-yaml`) sat on a production path
for four days while CI printed it on every run. Nobody acted, and no single
person is the reason:

- the audit step was `continue-on-error: true`, so the build stayed green;
- it audited the whole tree, so the one production finding sat among dev noise;
- its comment deferred triage to "the Dependabot PR", but Dependabot alerts were
  enabled and reported **zero** open alerts for it;
- when it was finally read, the advisory's own prose said the 3.x line had no
  fix — while `patched_versions` on the same record said `>=3.15.1`, a release
  that had existed for a week.

Every one of those is a default that looks reasonable. The rules below exist
because each of them failed in the same incident.

## What each step proves, and what it does not

| step | green means | green does NOT mean |
| --- | --- | --- |
| `pnpm audit --prod --audit-level high` (blocking) | no `high`/`critical` advisory on a production path | nothing about `moderate`, and nothing about dev dependencies |
| `pnpm audit --audit-level moderate` (advisory) | **nothing** — it cannot fail | that the tree is clean; it is a report, not a gate |
| Dependabot silence | **nothing** | that no advisory exists. `dependabot.yml`'s `updates:` covers direct dependencies; a transitive advisory can be absent from alerts while `pnpm audit` reports it |

A check that cannot fail proves nothing, so do not count the advisory step as
coverage. If you want to know the state of the tree, run the audit and read it.

## An advisory appears

### 1. Is it reachable in production?

```
pnpm audit --prod --audit-level high
```

Production findings are the gate. Dev-only findings are real but are not build
blockers — see [Dev-scope advisories](#dev-scope-advisories-are-outside-the-gate).

### 2. Does a fixed release exist?

**Read the structured record, not the write-up.**

```
pnpm audit --prod --json | python3 -c "import json,sys; [print(a['module_name'], a['vulnerable_versions'], '->', a['patched_versions']) for a in json.load(sys.stdin)['advisories'].values()]"
```

`patched_versions` is authoritative. An advisory's prose may tabulate "the newest
release of each line" as affected and be out of date the moment a backport ships;
that is exactly how the `js-yaml` fix was missed. If the two disagree, the
structured field wins — and say so in the PR, because the next reader will hit
the same prose.

Then check the fix is reachable: does a version satisfying `patched_versions`
also satisfy every dependent's declared range? For `js-yaml` it did —
`gray-matter` requires `^3.13.1` and the fix landed in `3.15.1`. If the only fix
is in a major your dependents cannot accept, treat it as "no fix exists" (§5)
rather than forcing the major.

### 3. Moving a transitive dependency

**`pnpm update <pkg>` will not move it.** Neither will `-r` or
`--depth Infinity`: pnpm considers a transitive already satisfied when the
lockfile entry is inside the declared range, and does not re-resolve it. This was
measured, not assumed.

Use `pnpm.overrides` in `package.json`, **scoped by range**:

```json
"pnpm": {
  "overrides": {
    "js-yaml@^3": "^3.15.1"
  }
}
```

Scoping to `@^3` rather than the bare name matters: a bare `js-yaml` override
would also rewrite a future dependency that legitimately wants 5.x. There are
prior examples in the same block (`hono`, `body-parser`) — follow their shape.

### 4. Verify the move, twice

1. **The lockfile actually moved** — `grep js-yaml pnpm-lock.yaml` should show the
   patched version, and the audit should go quiet.
2. **The property you cared about actually changed.** An advisory says a version
   is patched; it does not say your usage is fixed. For `js-yaml` this was
   measured directly against the resolved tree: 3.15.0 quadruples per doubling
   (74 / 173 / 670 / 3,068 ms at n = 5k/10k/20k/40k) while 3.15.1 stays linear
   (83 / 82 / 112 / 171 ms).

Step 2 is not optional ceremony. A version bump that satisfies the audit while
leaving the behaviour unchanged is the same failure as a green test that never
ran the branch it claims to cover.

### 5. When nothing fixes it

Only reach here after §2 established that no reachable release is patched.

1. **Is there already a mitigation in the code?** Record it as *defence in
   depth*, never as *the fix*. Calling a mitigation the fix is what makes an
   out-of-date dependency look acceptable, and the next reader will not re-check
   it. (`MAX_FRONTMATTER_BLOCK_BYTES` bounds the `!!omap` path too — it is not
   why that advisory is closed.)
2. **Only then**, suppress it explicitly:

```json
"pnpm": {
  "auditConfig": {
    "ignoreGhsas": ["GHSA-xxxx-xxxx-xxxx"]
  }
}
```

   Every entry needs the GHSA id, the date, why no fix is reachable, and what
   bounds the risk meanwhile. An entry with no expiry condition is a permanent
   blind spot.

3. **Re-check on a schedule.** "No fix exists" is a state, not a verdict — the
   `js-yaml` backport landed a week before anyone looked.

## A dependency-update PR appears

The global rule is: never merge one on the spot. Concretely here:

1. **Compatibility** — peer dependencies satisfied, and the declared ranges of
   everything that depends on the moved package still hold.
2. **Majors are opt-in.** A major or otherwise breaking update is held and taken
   as a deliberate, separate change, never as part of a batch.
3. **The full gate, green** — all eight steps in
   `.github/workflows/node.js.yml`, not the three you can run quickly.
4. Never silence a version warning or force a peer to pass. If it does not
   resolve honestly, it is not ready.

## Dev-scope advisories are outside the gate

Narrowing the blocking pass to `--prod` was deliberate: mixing dev noise back in
recreates the step people stop reading. The cost is that a dev-scope advisory
blocks nothing, so clearing one is always a decision somebody makes rather than
something CI forces.

That has already happened once, and it is the pattern to copy. Two dev-scope
`high` findings — `brace-expansion` via `eslint`, `nanoid` via `vite` — were
found by *reading* the full-tree report during review, not by any gate, and
Dependabot had opened no PR for either. Both were cleared the same way a
production finding is, with range-scoped overrides. The tree currently reports no
advisories at all, in either scope.

So the rule this section actually carries is: **when you touch dependencies, read
the advisory step's output**, because nothing in CI will make you. A dev-scope
advisory is rarely urgent — it is build-time, not part of the server's attack
surface — but "not urgent" and "nobody's job" are different things, and only the
first one is true here.

## What this does not cover

Nothing here inspects package *contents*. `pnpm audit` matches versions against a
database: it says nothing about a package that was never reported, and nothing
about install-time scripts. The controls for that live elsewhere — SHA-pinned
GitHub Actions, `CODEOWNERS` on `.github/`, and the untrusted-repo intake rules
in the global layer.
