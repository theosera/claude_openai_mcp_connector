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

**A split creates an investigation, not just two smaller tasks.** Every item
below was observed on this repository's own split. The list carries no count on
purpose: it has already gone stale twice as it grew.

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
- **Instructions queued for later.** A scheduled check-in, a brief handed to an
  agent, a note left for the next session: each is a half that stops matching
  the other the moment the state moves. Three check-ins fired here carrying
  branch heads and lists of open work that had changed since they were
  written. When the state moves, the queued instructions move with it, or
  they arrive wrong and are followed anyway.
- **A gate that lives in one session.** A width check run on this file was
  described, in the commit that acted on it, as exiting non-zero "so the next
  commit cannot step over it the same way". It was a shell command in one
  session's scrollback. The next commit arrived from another session four
  minutes later and the check never ran; that commit happened to conform, so
  nothing broke. That is why the claim survives — a run of luck is
  indistinguishable from a working gate, and a control binds the future only if
  it is committed where the future will run it.

The check that finds these is not a diff of either half. It is the **merged
tree, read** — produce it before either half lands (`git merge-tree`) and read
the result, because the merge that hides the problem is the one that succeeds.

## Correcting is where the next defect comes from

Every correction made to the write-boundary work was itself stated more broadly
than it held, and the next reviewer found the overreach — six times on one pull
request, none of them caught by the person writing the fix. The pattern is
specific enough to plan around.

**A correction over-asserts.** The finding that prompted it was hedged — "may
already carry", "when X is configured" — and the fix hardened the hedge into an
assertion. Write the correction with the finding's qualifiers still attached,
and check that removing the error did not also remove one of them.

**Enumerating conditions loses one, and never the same one twice.** Three
consecutive reviews of a single paragraph each found a different missing
condition, each time after the paragraph had listed the conditions its author
knew about. Listing them a fourth time is the same bet again. **Replace the
enumeration with something the reader can observe**: instead of "the tools
appear when A and B and C hold", say "list the tools — if they are there, you
are done". An observable test stays correct as the implementation grows
conditions. A list does not.

**A finding can be right about the defect and wrong about the fix.** One review
correctly identified a missing distinction, then prescribed an action the
operator has no way to perform — which was the defect under repair, arriving
from the other side. Accepting a finding is not accepting its remedy; say which
part you took, and why the other part was not it.

**And a fix reaches only the copy you edited** — the seam section above, applied
to one rule living in two files.

## Choosing the model tier

The axis is **not difficulty**. It is whether a miss leaves a trace.

| | Cheapest tier that fits | The top tier — name it, do not assume it |
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

That example stopped being hypothetical while this file was open. Four sibling
pull requests were read one at a time. The first said `clean`; the second,
`unstable`; a conclusion drawn from those two — that the field tracks conflicts
and checks — went into a pull request body, and the third said `blocked` and
contradicted it inside the hour. The actual cause was two review threads that
had been answered hours earlier and never marked resolved, and it was
settled not by a fourth reading but by **intervening**: resolving them flipped
that pull request to `clean` on the next fetch, with no commit, no check and no
review in between. Two lookups produced a confident wrong answer, four produced
a correlation, and one intervention produced the cause. **A state assembled
from several sources is not done being read when the readings agree** — the
agreeing ones had simply not yet met the case that separates them.

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

### The superlative is a trap: name the model

"Strongest model available" names no model, so it resolves to whatever the
reader already believes sits on top — and that belief is exactly the kind of
fact that moves. On 2026-09-08 a session read this section, classified a
merge-state question into the right-hand column correctly, and dispatched to
`opus`. The operator asked whether Fable was not the stronger of the two; the
`claude-api` skill settled it in one line. The classification was right and the
model was wrong, which is the worst shape for this mistake to take — nothing
about the dispatch looked irregular, so nothing prompted a second look.

**Do not resolve the superlative from memory.** Load the `claude-api` skill and
read its model table; that skill's own trigger says model-choice questions are
never to be answered from recall. As of 2026-09-08 the table puts Claude Fable
5.1 (`fable`) above Claude Opus 5 (`opus`), at twice the per-token price. The
sentence you are reading is a cache. The skill is not.

### Ask whether the task is security-adjacent before reaching for the top tier

The top tier is not automatic even for a right-hand-column task. Ask first
whether the work sits near secrets or a security boundary — `.env` files, API
keys and tokens, credential handling, authentication, permission or deny
configuration, or a review whose subject is any of those.

If it does, dispatch to `opus` rather than `fable`.

The reason is an operator observation, not a measurement made here, and it is
written that way on purpose: the operator reports having seen agents on
security-adjacent work behave as though they had been dropped to an Opus-class
model partway through. **This document does not establish that mechanism.** No
run has been instrumented for it here, and the observation would look the same
if the cause were a property of the task rather than of the routing. What
follows from it is a choice, not a theory: if the top tier does not reliably
stay the top tier in that neighbourhood, asking for it there buys an
expectation instead of a capability — and an expectation that fails quietly is
worse than a tier chosen deliberately. Choose `opus`, and know what ran.

### Record what actually ran, especially when it is not what was asked for

The spawning tool takes a model. It does not report which model served the run.
The only route to that fact is to ask, so **every delegated brief should require
the agent to state the model it is running as**, at the top of its report rather
than buried inside it.

That self-report is a claim, not an independent measurement — an agent that was
re-routed may or may not be able to see it. A matching report is weak
confirmation; a mismatching one is strong evidence. Not the reverse.

When the reported model is not the requested one — a `fable` dispatch answering
as an Opus-class model, or any other substitution — **record it**: which model
was asked for, which was reported, the shape of the task, and whether it was
security-adjacent. One instance is an anecdote and a run of them is a pattern,
but only if they are written down somewhere the next reader will look; without
a record this stays an impression, and an impression cannot be checked.

That record does not belong in this repository. This one is public, and what
would make the record useful — the session, the task, the timing — is the same
operational detail that has already had to be requested for removal from it
once. Keep it in the operator's own notes, and keep the requested model in the
brief so the two can be compared at all.

## What cannot be set, and do not pretend otherwise

The agent-spawning tool takes a **model**. At the time of writing it takes no
**reasoning-effort** parameter, and effort is inherited from the calling
session. Read the tool's own parameter list before relying on that sentence —
it is a cache, and caches go stale.

It also returns no **served model** — what was requested is the only model the
caller ever sees, which is why the section above asks the agent itself.

Never describe an agent as having run at an effort level that was not actually
settable, or on a model that was only ever the one requested. A run reported as more thorough than it was is worse than one reported
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
  pattern has been shown to match something else;
- a positive control for every empty result, because **"nothing matched" is more
  often a broken check than an absent thing**. Three checks in a row misreported
  here — twice because the text wrapped across the line the pattern searched,
  once because a backtick was missing from the pattern — and each time the thing
  being checked was fine. Stopping at any of them would have raised a false
  alarm about the work rather than the instrument. Two more of the same kind,
  from a session working alongside this one: a pattern written in lower case
  against text written in upper case, and a check keyed to line numbers that the
  very edit it was checking had already moved. Both reported the fixed thing as
  unfixed. **Anchor a check on content, and normalise case and whitespace before
  matching** — the instrument has to survive the edit it is measuring;
- **whether the question has one denominator or two.** A change that closes an
  exception has to reach the places that *state the exception* — they become
  false — and separately the places that *tell someone what to do* — they gain a
  requirement. Those are different sets, and a sweep aimed at the first is not
  short, it is answering a different question. That happened here: three search
  methods were run carefully over one denominator while the other was never
  enumerated at all, and review found it. **Ask how many sets the change touches
  before asking how to search one of them**;
- **an as-of that was measured, not carried forward.** State timestamps go stale
  the ordinary way, and a report can also be wrong about *when it is* — times
  extrapolated from a reading taken earlier in the same session were off by
  hours here, in a report that carried an as-of and therefore looked more
  trustworthy than one without. **An unmeasured as-of is worse than none**: it
  invites the reader to trust a window that was never observed. Take the
  timestamp immediately before writing it, from the clock, every time;
- **the unit the check counts, written next to the number.** A width check here
  counted bytes while the limit it enforced was in characters, and against prose
  full of em-dashes the two part company. Of the ten lines it flagged, seven
  were inside the limit and two were table rows that cannot wrap — leaving one
  real defect that looked exactly like the other nine in the output. A check
  whose every hit must be re-verified by hand is not a gate. The tell is cheap:
  measure one flagged case both ways;
- and, before asking what any check found, whether the instrument can answer the
  question at all. That is not the same as a check that did not reach, and
  telling them apart is harder than it sounds. **This document got it wrong
  here, and the wrong version survived two commits.** It said that asking a pull
  request's *reviews* whether a particular bot had reviewed it "can never return
  yes, because that bot posts comments and never a review". The empty result
  that produced that sentence was real. The reason given for it was invented:
  the bot posts an edited issue comment while it is declining or queueing, and
  submits an ordinary review when it actually reviews — which it then did, on
  this pull request, and the query that supposedly could never return yes
  returned it. **An empty result plus a plausible mechanism is still an empty
  result** — and the mechanism is the part that feels like evidence. Three
  different claims sit behind one silent check, and each needs its own work.
  *This check did not reach* is what an empty result gives you by itself.
  *The thing is genuinely absent* needs a positive control: the same check,
  returning a hit on a case known to be present. *The instrument cannot answer
  this at all* needs more than either — its documented contract, or a case where
  the thing is known present and the instrument still says nothing. **A positive
  control cannot establish that last claim; it establishes the opposite.** The
  sentence this bullet replaced said to reach for one before claiming it, which
  had the logic backwards and was caught by a reviewer rather than by its
  author, again.
