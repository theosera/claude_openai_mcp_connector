# Policy Enforcement & Provenance — a proposal

Assessed 2026-08-17 against `6897747` (v0.9.0).

This evaluates whether a set of OS-level security ideas — a policy layer a
privileged component cannot talk its way past, artifact provenance, tamper
detection, fail-closed degradation — should be applied to this connector. The
prompt for it named Red Star OS as the source of those ideas; what is taken from
there is only the general architecture (privilege separation, tamper resistance,
provenance, fail-closed), and explicitly **not** surveillance, covert tracking,
or watermarking user data. Those are refused in §D on their own merits, not as a
formality.

**The proposal adds no MCP tool.** `registerTool` is called **17** times and
`docs/context-engineering.md` caps the net surface at 15 → 17, with both reserved
slots consumed by `get_context` (#122) and `get_project_state` (#125). Adding one
would be a decision to exceed a documented cap. **That is a constraint here, not
a preference** — every item below is shaped by it.

---

## The finding, up front

The request assumed a missing layer:

```
Agent → Connector → OS / Files / External API          (what it assumed exists)
Agent → Connector → Policy Enforcement → Capability    (what it proposed adding)
```

**The second diagram already describes this server.** Capability checks,
resource boundaries, integrity checks and provenance all exist; they are
distributed across `pathSafety`, `surfaceFor`, and a choke point in each store
rather than centralized in one module (§B).

So the useful output is not a new layer. It is narrower, and arguably more
valuable: **two places where a rule this repo already enforces has not reached
one last spot.**

| | The rule | Enforced for | Not reached |
| --- | --- | --- | --- |
| **GAP-3** | A policy source must not live inside the data plane it governs | `MCP_OAUTH_STATE_FILE`, `MCP_PATCH_STATE_DIR` (incl. its derived default), `MCP_CONTEXT_TYPE_RULES` | **`MCP_ENV_FILE`** |
| **GAP-4** | Authority is derived from the presented principal's scopes | OAuth tokens (`record.scope`) | **the static bearer** (unconditional full scope) |

Neither is a design gap. In both cases the principle is stated, implemented, and
tested — it simply stops one variable short. **That framing changes the work:
finishing a rule is a smaller and better-defined task than introducing one**, and
it is the same conclusion that rejects a centralized policy engine in §G.

---

## A. Current architecture — the trust boundaries that exist

```
Agent (LLM client)
  │  boundary 1: tool arguments are untrusted (zod schema + allowlists)
MCP interface
  ├── HTTP  handleRequest: auth 401 → scope 403 → rejectRebinding 403 → body cap 413
  │         → createMcpHandler(legacy:'stateless') → surfaceFor(principal)   [per request]
  └── stdio serveStdio: carries no principal; the surface is a constant of the env flags
buildMcpServer   capability == whether registerTool is called at all
  │              (17 tools today; each store wrapped in withClientSafeErrors)
Stores  multiRootStore → knowledgeStore / skillStore / auditStore
  │  boundary 2: pathSafety's staged guard, realpath, symlink-escape, reserved subtrees
Filesystem (KNOWLEDGE_ROOT)
```

Three properties of this shape matter for the rest of the document.

**Policy comes from the environment, once, at boot.** `loadConfig` /
`loadHttpConfig` / `loadOAuthConfig` read it and nothing re-reads or mutates it.
There is no policy file, no policy API and no policy tool. The
"agent gains privilege → agent edits the policy → constraint lifted" path the
request worried about has **nothing to edit**: the only lever is the process
environment, which is the operator's, not the agent's.

**There is no subprocess surface and no outbound network surface.** Measured at
`6897747`: zero `child_process` / `spawn` / `execFile` call sites in `src/`, and
zero outbound `fetch` / `http(s).request` call sites. The server accepts
connections; it does not make them. Two of the request's themes — subprocess
rules and network-destination rules — therefore have **nothing to govern**. A
policy for them would be a policy over an empty set.

**Capability is expressed by absence, not by refusal.** A tool the current
principal may not use is not registered, so it is not in `tools/list` and cannot
be called. This is stronger than a permission check at call time, and §G returns
to why that matters.

---

## B. Existing controls — the proposed four layers, mapped

| Proposed layer | Where it already is |
| --- | --- |
| **Capability check** | `surfaceFor` intersects token scopes with the server's `MCP_HTTP_ALLOW_*` flags **per request**, and write tools are simply not registered when the intersection is empty (INV-6 item 4, INV-7 item 5). |
| **Resource boundary** | `pathSafety`'s staged guard (length cap → control-character reject → percent-decode validation → NFC → absolute/`~`/`..` reject → realpath prefix → symlink escape), the audit-subtree reservation (INV-9), the Skills subdir (INV-8), writes confined to the primary root, and `assertOutsideKnowledgeRoots` keeping server state out of the vault. |
| **Integrity check** | `expected_sha256` staleness rejection and `content_sha256` on staged plans, an exact `confirmed_target_path` echo, `replaceFileAtomically` (same-directory temp → restore ownership → rename), the audit compare-and-swap, an HMAC over persisted OAuth state, and on the supply side SHA-pinned actions plus a blocking production `pnpm audit`. |
| **Provenance** | Server-owned frontmatter (`id`, `updated_at`) that client content cannot claim (`assertNoServerOwnedFrontmatter`), and staged plan records carrying `patch_id` / `target_path` / `created_at` / `reason` / hashes with a seven-day sweep. |
| **Fail-closed** | Refuse to start without `MCP_AUTH_TOKEN`; refuse to start on an OAuth config missing its issuer or password; `surfaceFor` throws rather than defaulting (the default would be the full surface); an unrecoverable principal throws; write paths throw on frontmatter the reader would have degraded past. |
| **Agent-resistant guardrail** | `SERVER_INSTRUCTIONS` states that bodies, frontmatter, search results and tool output are data — never instructions, never approval; every document edit is plan → human approval → apply; the one single-call write is off by default precisely because its approval rested on the model; `fetch` fails closed when a reference resolves to more than one document. |
| **Declared vs. live verification** | `scripts/check-http.mjs` runs the handshake against a live endpoint and **fails** if the tool surface is *wider* than the `.env` flags declare — including an unrecognized write-capable tool. |

The last row is worth calling out: the request asked for tamper detection of
configuration, and the shape that already exists here is better than hashing a
config file. **It compares the declared policy against the surface actually
served.** A hash tells you a file changed; this tells you the endpoint is doing
something the configuration did not authorize, which is the question worth
asking.

---

## C. Which of the source principles apply

1. **Privileged ≠ trusted.** Broadly realized already — but see GAP-4, where one
   principal is trusted by construction.
2. **A policy source must not live in the data plane.** Realized for three
   variables; see GAP-3 for the fourth.
3. **Provenance means being able to reconstruct events afterwards** — and the
   carrier should be an out-of-band log, not the artifact (§F).
4. **Fail-closed is decided per operation class, not globally** (§E, GAP-6).

## D. Which do not

- **Watermarking or hidden markers in user content.** Excluded by the request,
  and independently incompatible: the server returns note bodies **unmodified**
  (INV-5), and frontmatter identity is server-owned specifically so that content
  cannot carry claims (INV-2). Embedding anything invisible in a user's notes
  would contradict both.
- **Tamper resistance aimed at the operator.** This is a single-user,
  local-first server; there is no party above the operator whose policy the
  operator should be unable to change. Building that here would be surveillance
  wearing a security label, which is exactly the part of the source design this
  proposal declines.
- **Identity-based runtime routing** (switching tool surfaces by detecting which
  client connected). Already rejected in the ROADMAP appendix, and re-proposing
  it as "policy" would not change what it is.
- **Runtime self-hashing of the server's own code.** An attacker who can rewrite
  `dist/` can rewrite the verifier in the same step. The controls that actually
  hold here are the lockfile, SHA-pinned actions, CodeQL, and a blocking audit.

---

## E. Gaps

| ID | Gap | Status elsewhere |
| --- | --- | --- |
| **GAP-1** | No server-side event log: who searched, fetched or wrote what cannot be reconstructed. | ROADMAP 🔭; the threat model's Repudiation row already flags it. |
| **GAP-2** | A staged plan is not bound to the **vault** it was staged for. | ROADMAP, open. |
| **GAP-2′** | A staged plan is not bound to the **principal** that staged it. | ROADMAP, open — a **different** boundary; see §G. |
| **GAP-3** | `MCP_ENV_FILE` is outside the containment rule its three siblings follow. | ROADMAP, open and explicitly marked *unevaluated, not rejected*. |
| **GAP-4** | The static bearer receives full scope unconditionally. | **Not recorded anywhere before this document.** |
| **GAP-5** | stdio has no declared-vs-live check; HTTP has `check-http.mjs`. | Partial. |
| **GAP-6** | Fail-closed behaviour is implemented but not written down per operation class. | Nothing. |

### GAP-4 in detail, and where the documentation misleads

`authenticate()` in `src/httpServer.ts` returns
`{scopes: [SCOPE_READ, SCOPE_WRITE]}` as soon as `isAuthorizedHeader` succeeds.
Nothing narrows it. Consequences:

- A **read-only static token cannot exist.** There is no way to hand out a
  bearer that can search but not write.
- On a write-enabled endpoint, `surfaceFor`'s two conditions collapse to one:
  the flag. The token contributes nothing.
- "Enable writes for the web client but keep the bearer read-only" is not
  expressible.

What limits the blast radius today is the **two-endpoint deployment** documented
in `operations.md` §9: the unattended scanner runs against an endpoint with
general write off, so a leaked scan bearer reaches only the audit subtree. That
is endpoint separation doing the work — a deployment property, not a property of
the token.

Several documents state the protection as two conditions. That phrasing is
**accurate for OAuth tokens and misleading for the static bearer**, so a caveat
now sits next to the places that state it as a current protection —
`threat-model.md` (the data-flow diagram and two STRIDE rows), `README.md`'s
scope-gating paragraph, and the `operations.md` hardening checklist. Three files,
five places.

Everywhere else the two conditions appear, the passage limits itself, and those
were **left alone**: annotating correct text is its own kind of error. What makes
each one correct is a phrase, so the phrase is recorded here instead of the
verdict:

| Left alone | What limits it, verbatim |
| --- | --- |
| `operations.md`, Skill-write section | "Over HTTP the tools are also **OAuth scope-gated**" |
| `README.md`, cloudflared/OAuth section | "a **connector** only receives `vault.write` when at least one explicitly enabled write surface exists" |
| `PRFAQ.en.md` | "Writes **over the web path** are enabled only when **both** …" |
| `PRFAQ.md` | 「**web 経由**の write は … 両方が揃ったときだけ」 |

The first two name OAuth outright. The last two lean on their surrounding
question, which is about the Chat-connector path and introduces it a few lines
earlier as the OAuth surface — weaker, and sufficient. Env-var listings and
configuration examples were left alone as well: they name flags without claiming
a protection.

**The sites were classified by reading them, and the direction of that matters.**
A grep for `MCP_HTTP_ALLOW_WRITE|vault\.write` is structurally a superset, so
reading can only remove sites: eleven hits became eight became five. The
shrinkage is the shape of the method, not a bias in it. It is not symmetric,
though. Over-inclusion — annotating a passage that was already correct — is
caught by anyone who reads the passage. **Under-inclusion catches nothing**: a
misleading passage filed as correct stays misleading, and the filing leaves
nothing behind to check. Quoting the limiting phrase is what gives
under-inclusion a check of its own — if a quoted phrase turns out not to limit
the claim, that is visible without redoing the survey.

The check found something before it was in place. This paragraph previously said
the caveat also sits next to "both PRFAQ files"; it does not, and never did. The
two were reclassified while the work was underway, the reclassification was
right, and the sentence describing it was not updated to match — **a document
went stale about its own scope inside a single change.** It surfaced because a
review asked what the judgements rested on, which is the question the table above
now carries in the document itself.

**For contrast, on the containment side the same repo goes considerably further
than the documentation claims.** `canonicalizeForRootComparison` walks from the
filesystem root one component at a time, `lstat`-ing each and following symlinks
by re-splicing the remaining segments (bounded by `MAX_SYMLINK_HOPS`), and
`isInsideRoot` compares `(dev, ino)` identity rather than path spelling — so
hardlinks, bind mounts and case-insensitive aliases are all caught.

When the root does not exist yet there is no identity to compare against, and it
falls back to spelling — written to avoid the `..state` false positive rather
than reaching for `startsWith("..")`. **The comment on that fallback is the part
worth reading**, because it explains why the same predicate is safe elsewhere:

> `relativeToRoot` in `pathSafety.ts` uses the same predicate safely because its
> polarity is the opposite one: there a false "escape" refuses a legitimate read
> (fail-closed); here it would admit a real leak.

**Two surfaces, one predicate, opposite consequences — and the code was written
knowing which was which.** That is the strongest available evidence that the
absence of scoping on the static bearer is a spot the rule has not reached, and
not a place where nobody thought about it. It is also the same observation the
top of this document makes: the principle is constant, **its shape is decided per
surface** — the way INV-2's "content cannot vouch for itself" came out as *refuse
to resolve* in the link graph, *cap the weight* in `get_context`, and *return the
path but never the body* in `get_project_state`.

---

## F. Proposed architecture

**No new layer.** The request's diagram is the existing design; the additions go
inside choke points that already exist:

```
Agent → MCP interface → Connector
   ├─ Capability check  surfaceFor                unchanged  + scope the static bearer   [GAP-4]
   ├─ Resource boundary pathSafety / reservations unchanged  + MCP_ENV_FILE              [GAP-3]
   ├─ Integrity check   sha256 CAS                unchanged  + bind a plan to its vault  [GAP-2]
   └─ Provenance        —                         new: an out-of-vault event log         [GAP-1]
→ External resource
```

### Where provenance should live

| Carrier | Verdict | Why |
| --- | --- | --- |
| Sidecar files in the vault | ✗ | A knowledge root is a read surface. A `.md` sidecar is indexed and returned by `fetch` — the same reasoning that made INV-9 reserve a subtree. |
| Embedded in the artifact | ✗ | Violates INV-5 (bodies are returned unmodified) and is excluded by the request. |
| Git metadata | ✗ | `KNOWLEDGE_ROOT` is an arbitrary directory; there is no guarantee it is a repository. |
| Content hashes | already present | `expected_sha256` / `content_sha256` exist; nothing to add. |
| **Append-only structured log outside the vault** | **✓** | Fills the one real gap and matches the rule that keeps server state out of the roots. |

**Whose repudiation this closes matters.** The subject is the semi-trusted
agent — adversaries (1) and (3) in the threat model — not the operator.
The question worth answering after the fact is *what did an injected session
do*. Saying so keeps §D's refusal of operator-directed tamper resistance and
this item from contradicting each other.

---

## G. Candidates

### Adopt

| | Change | Priority |
| --- | --- | --- |
| **A1** | Re-check `MCP_ENV_FILE` for containment once the roots are known, and refuse to keep serving if it is inside one. | P2 |
| **A2** | Record the originating primary root in a staged plan; verify it at apply. | P1 |
| **A3** | A content-free, append-only, out-of-vault event log. | P1 |

**A1 is a graduation of an existing ROADMAP item, and it is weaker than it
sounds.** The entry already contains the analysis, including the part that
matters: by the time the roots are known the secrets are in `process.env`
already, and a file sitting in an indexed root may already have been read. This
does **not** prevent exposure. What it buys is refusing to keep serving on
credentials a vault reader may know. Calling it "reuse the existing containment
check" is right about the implementation and wrong about the guarantee —
`MCP_OAUTH_STATE_FILE` fails *before a write*, this fails *after a read*. Its
priority input is also thin: the "no deployment sets it" evidence covers **one
host, and one of at least two endpoints on that host**.

**A2 covers the vault half only.** GAP-2′ (principal binding) is a separate
boundary and should stay a separate change; one PR, one boundary. For an
unrecorded plan the right behaviour is to **reject** — but not for the reason
that first suggests itself. "The seven-day TTL drains them anyway" is false: the
sweep is staging-driven, and `patchState.ts` says outright that a server which
stays up and stages nothing more never sweeps again. **The window does not close
on its own, which is an argument for rejecting rather than warning** — a warning
needs an end date, and there is none.

**A3's constraints** are recorded on the ROADMAP item itself: no new tool
(17/17), `MCP_EVENT_LOG_*` rather than `MCP_AUDIT_*` because three audit
variables already mean something else, three states if the startup line reports
it at all, the startup line is not the check, and the reverse verification is a
**negative** assert. Its precondition is the CIMD question, since attribution
would key on `client_id`.

### Adapt

- **B1 — make the static bearer scopeable** via an optional
  `MCP_AUTH_TOKEN_SCOPES` that can only narrow. Default unchanged. Details and
  the reverse-verification trap are on the ROADMAP item.
- **B2 — a `check:stdio` counterpart to `check-http.mjs`.** It must spawn the
  real entrypoint and read `tools/list`; **parsing the startup line would
  reproduce the very gap it exists to close** (#113 measured it: restoring the
  Skill gate turned one wire test red and left the startup-line test green).
- **B3 — the fail-closed matrix**, now in `threat-model.md` §5.

### Defer

- **GAP-2′** principal binding — same invariant as A2, different boundary.
- **Stamping a policy version into artifacts** — the event log is the right
  carrier; revisit once it exists.
- **An integrity manifest for `.claude/` hooks and skills** — harness-layer, and
  the ROADMAP already carries the out-of-vault signed-manifest question.

### Reject

- **A centralized policy-engine module.** Two reasons, and the second is the
  real one. It would re-implement guards that are already choke points, against
  a large pinned test suite. More importantly it would **weaken the guarantee**:
  today an unauthorized tool is *not registered*, so it cannot be discovered or
  called; a policy layer necessarily becomes *registered but refused at call
  time*, which is strictly weaker. **Adding the layer would lower the property
  the layer exists to provide.**
- **Watermarking / embedded markers** (§D).
- **Identity-based runtime routing** (§D).
- **A "policy floor" env layer above the existing flags.** Duplicates the flags;
  no attacker model separates the two.
- **Runtime self-hashing** (§D).
- **Making everything fail closed.** Two documented exceptions exist for stated
  reasons: a patch-state permission tightening that fails is warned past (the
  file mode still applies, so it is not a missing layer), and the read path
  degrades on unparseable frontmatter because a reader has an obligation to keep
  serving a note that a writer does not have. Flattening these would be a
  regression, not a hardening.

---

## H. Cost

| | Security benefit | Complexity | Maintenance | Performance | Compatibility |
| --- | --- | --- | --- | --- | --- |
| **A1** | Low–moderate — **not** preventing exposure; declining to keep serving on possibly-known credentials | Low | Low | None (boot only) | Low — one more way to refuse to start |
| **A2** | Moderate — closes cross-vault apply | Moderate — the on-disk record changes | Low | None | Low — unrecorded plans are rejected |
| **A3** | **High** — the only open repudiation gap | High | Moderate — keeping bodies and PII out is ongoing | Low (writes only) | Low — opt-in |
| **B1** | Low–moderate | Low | Low | None | Low — default unchanged |
| **B2** | Low — observability | Low | Low | None | None |
| **B3** | Low — documentation | Low | Low | None | None |

**Sequencing.** A1 → A2 → A3 → B1/B2, one boundary per change. A2, A3 and B1 are
each a security-boundary change and each fires the pre-commit security review;
A1 does not, since it only adds a refusal to start. **B1 firing is the
non-obvious one** — the scope `authenticate()` returns decides `surfaceFor`'s
`allowWrite`, so a one-line change there is a write-surface gate change.
