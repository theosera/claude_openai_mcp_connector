# Delegating to a subagent

When to hand a task to a fresh agent instead of doing it in the current session,
and how to choose the model tier once you do. `CLAUDE.md` carries the trigger;
this file is the rule and the measurements behind it.

## The rule

**Delegate any investigation whose answer does not depend on what this session
already knows.** Surveys, sweeps, verification of a claim, independent review,
"find every X" — all of these are better from a clean context and worse from a
long one, for the same reason: an accumulated context supplies expectations, and
expectations are what a survey exists to test.

**Do not delegate work that needs the caller's context.** Applying an edit the
user just approved, continuing a judgement already in flight, anything where the
missing context would have to be reconstructed before acting — that stays where
the context is.

**Do not run the delegated search yourself in parallel.** Two passes over the
same ground from the same expectations do not cross-check each other. They
agree, which reads like confirmation and is not.

**An agent that has received a delegated investigation carries it out.** The
first rule is for deciding what to do with work that arrives without a scope. An
agent already holding one is where the fresh context was supposed to land, so
passing it on again spends the advantage instead of using it — and because the
rule would apply just as well to the next agent, there is no depth at which it
stops on its own. **A recipient never passes its scope onward** — which is
narrower than "never delegated twice", deliberately: the *caller* may hand the
same scope out again, to retry after an agent fails, or to two agents at once
when the point is to check one against the other.

## When work is split, investigate the seam

Splitting a change — into two PRs, two commits, two agents — makes each half
locally complete and the seam invisible from inside either one. Both halves pass
their own review. What breaks lives between them, and nothing turns red.

**A split creates an investigation, not just two smaller tasks.** Four things to
look for, each of them observed on this repository's own split:

- **What each half stopped saying.** A statement that was true of the combined
  change can be false of one half alone. Splitting a documentation fix by defect
  kind left one PR silent about a passage the other one owned — correct while
  they were one change, an omission the moment they were two.
- **What both halves now say.** Two independently written passages about the
  same thing merge *without conflicting* when they do not overlap textually, so
  version control surfaces nothing. Whoever resolves the one conflict that is
  surfaced gets no signal that the prose needs reconciling.
- **Tense and cross-reference.** A sentence describing the state the other half
  fixes is true until that half lands. Anchor it to a revision, or word it so it
  holds whichever order they land in.
- **Whether a correction reached every copy.** A fix applied to one half's copy
  of a shared rule leaves the other copy stating the uncorrected version. That
  happened here inside a single pull request's lifetime, to the fix for this
  file's own missing base case.

The check that finds these is not a diff of either half. It is the **merged
tree, read** — produce it before either half lands (`git merge-tree`) and read
the result, because the merge that hides the problem is the one that succeeds.

## Choosing the model tier

The axis is **not difficulty**. It is whether a miss leaves a trace.

| | Cheapest tier that fits | Strongest model available |
| --- | --- | --- |
| Shape of the task | single-source lookup, fetch, mechanical scan, "where is X" | cross-checking sources, judging whether a claim holds, any statement of completeness, absence, or agreement |
| Why | the answer is one thing, and a reader can check it | **a miss leaves nothing behind to check** |

A hard question with one verifiable answer is safe on a cheap tier: if the
answer is wrong, that shows. An easy-sounding sentence — "no other site
matches", "the two agree", "nothing else is outstanding" — is not safe there,
because an omission from it is invisible to everyone downstream, including the
person who asked for it.

A worked example: **"merge is blocked" belongs to the right-hand column.** The
phrase names a state, not a cause, and the causes do not resolve to one lookup —
a missing approval, a required check that never ran, a code-owner rule, a
protected-branch setting, an unresolved review thread, a conflict with the base.
Answering it means reconciling several sources that each describe one part of
the state, and the characteristic failure is reporting the first cause found as
though it were the only one. That is an absence claim wearing a diagnosis, and
it leaves nothing behind when it is wrong.

The asymmetry is not a preference.
[`policy-provenance.md`](./policy-provenance.md) states it directly:
over-inclusion "is caught by anyone who reads the passage", while
"**Under-inclusion catches nothing**". The write-boundary caveat work produced
defects of the second kind repeatedly — among them a passage filed in neither
list, a denominator quoted from an instrument that could not reach four of the
six sites it counted, and an instruction written unconditionally that held only
conditionally. None of them turned anything red, and none was caught by whoever
wrote it. No count is given here on purpose: the tally was still moving while
this file was being written, and a number without an as-of goes stale faster
than the point it is supporting.

## What cannot be set, and do not pretend otherwise

The agent-spawning tool takes a **model**. At the time of writing it takes no
**reasoning-effort** parameter, and effort is inherited from the calling
session. Read the tool's own parameter list before relying on that sentence —
it is a cache, and caches go stale.

Never describe an agent as having run at an effort level that was not actually
settable. A run reported as more thorough than it was is worse than one reported
plainly, because the report is what the next reader trusts instead of re-running
the work.

## Reporting back

A delegated investigation returns **evidence, not conclusions alone**:

- the command and its output for each claim it makes;
- counts labelled with the method that produced them, and declared as lower
  bounds — a line-oriented search, a proximity search, and reading the text each
  find a different subset, and the denominator is their union;
- an explicit distinction between "the check found nothing" and "the check never
  reached the thing". An empty result is not evidence of absence until the same
  pattern has been shown to match something else.
