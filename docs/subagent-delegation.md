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

The asymmetry is not a preference.
[`policy-provenance.md`](./policy-provenance.md) states it directly:
over-inclusion "is caught by anyone who reads the passage", while
"**under-inclusion catches nothing**". Every significant defect found in the
write-boundary caveat work was of the second kind — a passage filed in neither
list, a denominator quoted from an instrument that could not reach four of the
six sites it counted, an instruction written unconditionally that held only
conditionally. None of them turned anything red. Each was found by a reader who
did not already believe the claim.

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
