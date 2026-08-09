# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **A note's frontmatter `id` could impersonate any other document, and no
  longer can.** `readDocument` takes `document.id` verbatim from the file's own
  frontmatter — untrusted vault content — and `fetch()` matched that id *before*
  the vault-relative path, with no uniqueness check. A single note declaring
  another note's server-generated uuid, or another note's path, therefore
  answered every lookup aimed at that other note: `fetch_document`, the ChatGPT
  `fetch` alias, `trace_sources`, and the target `plan_document_update` resolves
  before staging its edit.

  That last one is the sharp end: **two-step approval protects the approved
  content, never the approved target**, so a diff the user reviewed and approved
  landed on the impostor file. Documents this server created are the most
  hijackable, because `create_document` / `plan_document_create` stamp a
  `crypto.randomUUID()` — their own path is never claimed by their own id, so a
  squatter is the *only* id match and wins regardless of scan order.

  `fetch` now resolves a reference only when it names exactly one document
  across the id and path namespaces, at **both** `KnowledgeStore.fetch` and
  `MultiRootStore.fetch`; an ambiguous reference fails closed.

  **Not path-first.** Resolving the path first would silently return a different
  document than the citation carrying that id pointed at — the mis-routing the
  composite's id-first match exists to prevent (a vault note with
  `id: "ops:secret"`, where `ops` also names a root). The error names the
  colliding documents by relative path so a genuine duplicate is fixable.

  **Refusing does cost reachability, and the error says so.** An earlier draft of
  this entry claimed "the exact vault-relative path is the one handle no file's
  content can claim". That is false, and the test suite proves it: a frontmatter
  `id` CAN be a vault-relative path, and claiming one is the primary attack
  shape. A victim that carries its own uuid stays reachable by that uuid, but a
  note carrying **no** frontmatter `id` has exactly one handle — its path, since
  its id *is* its path — and a squatter claiming that path leaves it with no
  reference at all. Both cases are pinned. The error therefore does not tell the
  caller to retry with the exact path (that retry lands on the same collision);
  it says the reference cannot be disambiguated and the duplicate `id` has to go.

  **Two guards, because one is not evidence for the other.** A squatter in the
  primary root shadows documents in the read-only roots, and that collision is
  visible only to the composite. One test drives both stores; removing either
  call site alone was measured to turn its own scenarios red while the other
  store stays green.

  **Behaviour change, stated plainly:** one planted file now makes its victim
  unfetchable as well, so this converts a silent content swap into a loud denial
  of service. `fetch("ops:secret")` in a multi-root vault where a note carries
  that id and an `ops` root holds `secret.md` used to return the note; it now
  refuses and names both. Both remain reachable by exact path.

- **`pnpm run check:http` had verified nothing since the endpoint became
  sessionless; it does again.** The script read the `mcp-session-id` response
  header and threw when it was absent. Sessions were removed from `/mcp` in this
  same unreleased line — `createMcpHandler` with `legacy: 'stateless'` serves
  both protocol eras per request and neither issues that header — so the
  operator health check failed against every healthy server.

  That failure was not fail-safe. The script is the operator-side guard for "the
  live tool surface is not WIDER than the `MCP_HTTP_ALLOW_*` flags declare", and
  the throw happened _before_ that comparison, so the surface check never ran at
  all. A genuine widening would have been reported with the same red FAIL line
  operators had already learned to ignore. The header is now read so a peer that
  still sets one keeps working, and never required.

  `operations.md` §9 was corrected for exactly this drift when sessions were
  removed; its scripted twin was missed. A test now spawns the real script
  against the real endpoint and asserts that the surface comparison itself ran,
  so the two cannot diverge again.

- **The conservative cache hints on 2026-07-28 cacheable results are now pinned
  by a test (ROADMAP item 3).** The revision requires `ttlMs`/`cacheScope` on
  cacheable results, and the SDK fills them from a `cacheHints` option this
  server does not set — so `server/discover` and `tools/list` already go out as
  `ttlMs: 0` / `cacheScope: 'private'`. Nothing changed; what changed is that
  relaxing either value now fails a test.

  Both are load-bearing. `cacheScope: 'public'` would let a shared cache serve
  one principal's listing to another, which is exactly the leak "not registered,
  so not discoverable" exists to prevent — the tool surface is per-scope
  (INV-6/INV-7). And a non-zero `ttlMs` is unsafe **even at `private`**: the
  previous release made the surface follow the _token_, while a private cache is
  keyed by the _client_, so one client swapping bearers would be served the
  previous token's tool list. `CacheHint` carries `ttlMs` and `cacheScope` and
  nothing else, so there is no way to put the token in the key — which leaves
  `ttlMs: 0` as the only safe value rather than one option among several.

  The roadmap item said to use "a private cache scope, or a key that includes the
  effective scope and the enabled surfaces". The second option does not exist,
  and the first is insufficient on its own; both corrections are recorded there.

- **A registered `redirect_uri` can no longer name one host and resolve to
  another, and the consent page now says where approving sends the code.** The
  page asked for a password while naming neither the client nor the destination,
  so the only thing an operator could act on was that a page had appeared. Two
  separate problems had to be fixed together for a destination line to be worth
  adding.

  First, the WHATWG URL parser _removes_ tab, CR and LF from anywhere in its
  input instead of failing, so `https://claude.ai<TAB>.evil.example/cb`
  registers as a string that reads as `claude.ai` and resolves to
  `claude.ai.evil.example`. `isAllowedRedirectUri` now refuses control
  characters before parsing. Second — and this is why the fix is not "reject
  anything that is not already normalized" — userinfo round-trips byte for byte:
  `new URL("https://claude.ai@evil.example/cb").href` equals its input while the
  host is `evil.example`, so a normalization check passes it. Userinfo is now
  refused outright; it has no legitimate use in a redirect target. Registrations
  that are merely un-normalized (an explicit `:443`, a mixed-case host) are still
  accepted, because neither moves the host, and a rule that rejected them would
  reject ordinary client registrations for no security gain.

  The consent page states the destination as an **origin derived from the same
  `new URL(...)` that `authorizePost` builds its 302 from**, so the sentence and
  the navigation are one fact rather than two kept in step by hand. The client
  name is shown when the client supplied one, labelled as self-asserted and
  unverified — it comes from the registration request, so it is a recognition
  aid, never an authorization input (see the `client_id` appendix in
  [`docs/ROADMAP.md`](./docs/ROADMAP.md)). Granted scope is deliberately still
  not shown: `vault.read` is not enforced on the read tools today, so a scope
  line would state a restriction the server does not apply. That line lands with
  the per-request scope resolution (ROADMAP item 2b), which is what makes it
  true. Pinned by `tests/oauth.test.ts`, including a non-regression case holding
  the callback shapes real connectors register.

- **`MCP_SKILLS_SUBDIR` overlapping `projects/` is refused at boot.** The Skills
  subtree is reserved against the general write surface, and `create_document`
  always writes under `projects/`, so an overlap left every create failing the
  reservation — the create root dead for as long as the setting stood, and
  failing per-call in a place that does not explain why. `loadConfig` now
  rejects it at startup, matching the check `MCP_AUDIT_SUBDIR` already gets
  (INV-8 / INV-9 have the same disjointness requirement). Pinned by
  `tests/skillStore.test.ts`.

- **The default two-step plan-state directory no longer follows the caller's
  working directory.** A plan holds vault plaintext — the pre-edit text and the
  full proposed text — until it is applied. Unset, `MCP_PATCH_STATE_DIR`
  defaulted to `.mcp-state/patches`, which `path.resolve` interprets against the
  process working directory; for a client-spawned stdio server the client
  chooses that directory, so the plaintext landed wherever the caller pointed.
  The previous release closed the matching hole for env files (the server stopped
  reading `.env` from its working directory) and named this as the remaining
  follow-up. The default is now `~/.mcp-state/patches-<hash>`, where the hash
  derives from the vault's own path.

  The home directory is an anchor, not a guarantee: `os.homedir()` returns `""`
  when HOME is empty with no passwd entry to fall back on, returns HOME verbatim
  when HOME is relative, and throws outright when neither resolves at all (a
  container running as a numeric UID with no `/etc/passwd` row). The first two
  would make `path.join` produce a relative string that `path.resolve` re-anchors
  to the working directory —
  reinstating the very placement this default exists to prevent, and doing so
  precisely in the environments that strip HOME (service accounts, and the
  `--clearenv` bwrap recipe in [`operations.md`](./docs/operations.md#6-sandboxing-the-local-stdio-server-bwrap-optional)).
  When no absolute home is available the server therefore **refuses to start**
  and names the setting to configure, instead of quietly writing plaintext
  somewhere else. An explicit `MCP_PATCH_STATE_DIR` is still honoured exactly as
  before, including a relative one and including on a host with no home
  directory — overriding the setting is deliberate in a way that inheriting a
  default is not. Pinned by `tests/config.test.ts`, which asserts the default is
  unchanged across a `chdir` and that an unusable home fails closed.

  **Migration.** Deployments that set `MCP_PATCH_STATE_DIR` are unaffected; the
  documented systemd and launchd units already set it. If you relied on the
  relative default, plans staged before the upgrade stay in the old location and
  are not migrated — `apply_planned_update` will report an unknown `patch_id`
  for them. Re-run the `plan_*` call, or set `MCP_PATCH_STATE_DIR` to the old
  path. Nothing is deleted.

- **The session-archive hook no longer resolves an ambiguous vault scan, so the
  push target for a full transcript cannot be claimed by planting a directory.**
  `archive-session.sh` locates the private vault clone from `$SESSION_VAULT_REPO`
  or, failing that, by scanning `$HOME/*/` for a `.claude-session-vault` marker
  next to a `.git`. It took the **first** hit, and that scan decides where the
  entire session transcript — every user message, assistant reply, tool call and
  tool result — is committed and pushed. Anyone able to drop a marked git clone
  under `$HOME` therefore only had to win the lexical glob order to receive every
  future session; a directory named ahead of the real vault, with `origin`
  pointing anywhere, was the whole exploit. Measured against the unpatched
  script: the planted remote received the transcript (canary included) and the
  legitimate vault received nothing.

  The scan now resolves **only when it finds exactly one candidate** and
  otherwise archives nothing, which is the same no-op the "no vault found" case
  already took. `$SESSION_VAULT_REPO` still wins outright, so a host that
  genuinely holds two vault clones names the one it means — verified to still
  archive correctly with two candidates present. Two or more candidates and no
  env print a one-line count to stderr: silence here would be indistinguishable
  from a working archive that quietly stopped writing, and the count is what the
  operator acts on. The candidate paths are deliberately **not** printed — this
  script ships byte-identical in this public repo, and those paths are the vault
  location.

  Rejected as too broad: refusing an `origin` that carries several push URLs
  (breaks legitimate mirrors) and pinning one vault+origin pair per machine
  (locks out a second legitimate vault until a pin file is removed). Neither is
  needed to close the exploit.

- **Front matter that expands exponentially when serialized is refused instead
  of materialized.** js-yaml resolves an alias (`*a`) as a _shared reference_,
  so a few hundred bytes of nested anchors parse in microseconds while
  describing a tree with millions of leaves. Nothing pays for that until
  something walks the value as a tree — `String()` in `toStringArray`, or
  `JSON.stringify` of a fetched document — at which point the single-threaded
  event loop blocks while allocating toward the V8 max-string limit, which on a
  memory-capped host is a fatal heap OOM rather than a caught error. A ~500-byte
  block measured a 79 MB `JSON.stringify` and killed a 256 MB child process.

  Both halves were reachable. Under `tags` / `source_refs` / `client` /
  `project` the expansion happened on the always-on scan path, so the first
  `search_documents` / `list_projects` / `trace_sources` after the file appeared
  paid it. Under any other key it survived `normalizeMetadata` untouched into
  the returned document, so **every** `fetch_document` re-ran it. Vault content
  is untrusted, and an `append_audit_report` body is arbitrary client text that
  later scans walk, so this was reachable even on a scan-only deployment with
  general writes off.

  `parseMarkdown` now walks the parsed value the way a stringifier does —
  revisiting a shared node once per reference, which _is_ the expansion — with
  an explicit stack, and throws once the accumulated size passes a budget of
  `max(64 KiB, frontmatter source length × 16)`. Work is bounded by the budget,
  never by the expansion, and a cycle terminates because every visit adds at
  least one byte. Throwing lets `parseMarkdownSafe` degrade that note exactly
  like any other malformed front matter (empty metadata, raw body, `parseError`),
  so one hostile note still cannot abort a vault scan.

  **The budget is derived from `raw`, deliberately not from `parsed.matter`.**
  gray-matter defines that property as non-enumerable and its content-keyed
  cache returns `Object.assign({}, cached)`, which drops non-enumerable
  properties — so it is `undefined` on every repeat parse of content the process
  has already seen. A budget read from it collapses to the floor on the second
  read of a note, or on a second byte-identical note, and silently strips the
  metadata off large but perfectly legitimate front matter: a session-archive
  index with 900 `source_refs` lost its `id`, `client` and tags and fell back to
  a path-derived id. Reading `raw` keeps the budget identical on the first parse
  and every repeat.

  Measured amplification of legitimate front matter under this accounting:
  0.98× for that 900-`source_refs` index, 0.84× for a 5000-entry block tag list,
  2.0× for the worst legitimate shape (flow-style one-character tags) and 4.3×
  for an all-`!!timestamp` block — at least 3.7× headroom under the 16×
  multiplier, and the 64 KiB floor covers everything small. A 28-shape battery
  covering deep nesting, block scalars, `!!binary`, `!!set`, `!!omap`, merge
  keys, CRLF, BOM and CJK found nothing legitimate that trips it.

  **A scalar is charged what `JSON.stringify` emits for it, not its length in
  memory.** Charging the length is not merely loose, it is wrong in the
  attacker's favour: a control character costs two characters to write in YAML
  (`\0`) and six to serialize (`\u0000`), so a 16× budget bought ~32 references
  charged at 1 and emitted at 6 — an output of ~96× the source. Measured on that
  accounting, an 800 KB front-matter block passed the guard and produced a 62 MB
  `JSON.stringify`, which is the same heap OOM the guard exists to prevent, only
  bought with a larger file. The escaped size is now counted, with the scan
  bailing out as soon as the running total passes the budget so the walk stays
  proportional to the budget. The amplification figures above are unchanged by
  this: every string in every one of those shapes is escape-free, so it is
  charged `length + 2` either way.

  Incidentally this also fixes a pre-existing crash: a recursive anchor
  (`a: &a [*a]`) produced a genuinely circular object that made `fetch_document`
  throw `TypeError: Converting circular structure to JSON`, leaving the note
  unfetchable. It now degrades instead.

- **The server no longer reads a `.env` from its working directory.**
  ⚠️ **Action required before restarting — see the migration below.**

  `dotenv.config()` ran at import time with no path, so it read `.env` from
  `process.cwd()` and injected every key not already in the real environment.
  For the documented stdio deployment the MCP client spawns the server with only
  `KNOWLEDGE_ROOT` in `env`, which means **the working directory is whatever
  project the user happened to open** — untrusted ground. A committed `.env` in
  a cloned repository could therefore set `MCP_TRANSPORT=http`,
  `MCP_HTTP_HOST=0.0.0.0`, `MCP_HTTP_ALLOW_WRITE=1` and an attacker-known
  `MCP_AUTH_TOKEN`, turning a local read-only vault server into a network
  listener whose bearer secret the attacker chose. It could equally set
  `KNOWLEDGE_ROOTS`, which outranks the operator's `KNOWLEDGE_ROOT`. The
  DNS-rebinding allowlist is no barrier to a non-browser client, which sends any
  `Host` it likes — and the same file could set `MCP_HTTP_ALLOWED_HOSTS` anyway.

  An env file is now read **only** from an absolute path named by `MCP_ENV_FILE`
  in the real process environment, loaded once at startup rather than as an
  import-time side effect. There is no working-directory fallback. A relative or
  unreadable `MCP_ENV_FILE` fails at startup. Parsing and precedence are
  unchanged — the same `dotenv.parse`, so quoting, multi-line values, `export `
  prefixes, comments and BOM behave identically, and a value already in the real
  environment still wins over the file. Removing the `dotenv.config()` call also
  removes a banner it wrote to **stdout**, which on the stdio transport is the
  JSON-RPC channel.

  **Migration — do step 1 before deploying.** A supervised endpoint that keeps
  its configuration in `.env` will not start after this change; under `KeepAlive`
  it crash-loops, and `StandardErrorPath` will show
  `KNOWLEDGE_ROOT (or KNOWLEDGE_ROOTS) is required`.

  1. Add `MCP_ENV_FILE` with the **absolute** path of that endpoint's `.env` to
     each launchd plist's `EnvironmentVariables` dict (systemd users already pass
     the real environment via `Environment=` / `EnvironmentFile=` and need no
     change). This step is a no-op under the current binary, so it is safe to do
     first.
  2. Deploy, then **reload** each plist — `launchctl bootout gui/$(id -u)/<label>`
     followed by `launchctl bootstrap gui/$(id -u) <plist>`.
     `launchctl kickstart -k` restarts the process **without** re-reading the
     plist, so the key stays in the file, never reaches the job, and the endpoint
     crash-loops with the error above.
  3. Confirm it reached the running job —
     `launchctl print gui/$(id -u)/<label> | grep MCP_ENV_FILE` — then verify
     with `pnpm run check:http`.

  Point each endpoint at **its own** file. Migrating fully restores previous
  behaviour, including the `MCP_AUDIT_SUBDIR` matching invariant between the two
  endpoints.

  **A second thing to check, which does _not_ fail loudly.** A write-capable
  process that receives `KNOWLEDGE_ROOT` from its MCP client registration but
  took `MCP_AUDIT_SUBDIR` / `MCP_SKILLS_SUBDIR` from the working-directory `.env`
  will now start **normally with writes on and those subtree reservations off** —
  `assertNotAuditReserved` returns immediately when the subdir is unset. Every
  write-capable process must now carry those values in its real environment or
  its own `MCP_ENV_FILE`. To make the state observable, the stdio branch now
  prints its effective surface on stderr, e.g.
  `MCP stdio transport ready (write=on, documents=on, skills=off, audit=off)`,
  mirroring what the HTTP branch already did. stdout stays pure JSON-RPC.

- **Two-step plan files are written owner-only.** A plan holds the pre-edit text
  (inside its diff) and the full proposed text of a private note, so
  `MCP_PATCH_STATE_DIR` is the one place vault plaintext is copied outside the
  vault — and it was the only state store in the repo written without a mode:
  files landed at `0644` inside a `0755` directory under the usual umask, so any
  other local account could read staged note plaintext without ever
  authenticating to the MCP endpoint. Plans are only unlinked on a successful
  apply, so abandoned ones accumulate.

  The repository also contradicted itself here: `SkillStore` created that same
  directory with `mode: 0o700` while `KnowledgeStore` created it with no mode,
  and `KnowledgeStore.init()` runs first — so the permissive mode won. Both now
  go through one helper (`src/patchState.ts`) that creates the directory `0700`
  and writes plan files `0600`.

  Because `fs.mkdir` does not chmod a directory that already exists, init also
  tightens a directory left permissive by an earlier version. That is done
  through a single descriptor opened `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`, so the
  check and the change cannot be split by a swap; it is never recursive and never
  touches a parent. The whole permission triad is compared rather than only the
  group/other bits, because a directory left at `0500` clears `& 0o077` yet
  denies the owner the write permission every plan write needs.

  If the chmod fails — another owner, a filesystem without POSIX modes — the
  server warns on stderr and continues rather than refusing to start: the `0600`
  file mode is the primary control and does not depend on it, so failing start
  would turn a safe server into an outage. The warning names the environment
  variable only, never the resolved path.

  **A symlinked directory is the one case that fails closed instead.**
  `O_NOFOLLOW` surfaces it as `ELOOP`/`ENOTDIR`, and `fs.mkdir(recursive)`
  follows such a link happily, so this is where it is caught. Warning past it
  would be unsound: plan files would be written through the link into a directory
  another account owns, and `0600` on the files is no defence there, because
  unlink and rename are governed by the **directory's** permissions — that
  account could swap a staged plan for one carrying different content and a
  matching `content_sha256`, which is precisely the approve-this-exact-diff
  guarantee (INV-3) the two-step write exists to provide.

  **Operational note:** a deployment where processes under different UIDs share
  one `MCP_PATCH_STATE_DIR` stops working. Every documented deployment is single
  -UID, and under the default umask a second UID could not have written there
  anyway.

- **The general document-write surface can no longer reach the Skills subtree**
  (INV-8). `SECURITY.md`, the README and `CLAUDE.md` all stated that existing
  Skills are immutable, but the only subtree reservation on the write path
  checked `MCP_AUDIT_SUBDIR`; `StoreConfig` never received `skillsSubdir` at
  all. A `SKILL.md` under `MCP_SKILLS_SUBDIR` was therefore an ordinary indexed
  document that `plan_document_update` → `apply_planned_update` could rewrite
  wholesale — and Skills are loaded as _instructions_ by later agent sessions,
  so "edit a note" was a route to persistent agent-instruction injection. The
  same gap let exact-path create plant a new Skill bundle bypassing
  `SkillStore`'s name pattern, file allowlist and size caps. Notably
  `MCP_HTTP_ALLOW_SKILL_WRITE` did not need to be on: the general
  `MCP_HTTP_ALLOW_WRITE` surface was enough.

  The Skills subtree now carries the same reservation the audit subtree has
  (INV-9), at the same choke points — `planUpdate`, `applyPlannedUpdate` (the
  authoritative one, immediately before the write), both points in
  `resolveForWrite`, and `validateCreateTarget` — using the same lexical plus
  `realpath` comparison, so symlink, NFD and case-variant spellings are covered
  rather than only the client's literal string. `validateCreateTarget` checks the
  _resolved_ target, since its parent walk has already replaced every existing
  parent with its realpath; that also closes the same gap on the **audit** side,
  where a create aimed at a symlink alias of the reserved subtree used to plan
  successfully and only fail at apply, persisting a patch that could never be
  applied. Reads are untouched: Skills stay
  searchable, fetchable and indexed. The constrained `plan_skill_create` /
  `apply_planned_skill_create` surface is unaffected, because `SkillStore` does
  not go through `KnowledgeStore`.

  **Operating condition, same as INV-9's:** the reservation only holds in a
  process that actually sets `MCP_SKILLS_SUBDIR`. Every process that can write
  the vault — the interactive HTTP endpoint _and_ any local stdio server — must
  set the same value, or a Skill remains editable through the one that does not.

  The gate is inert when `MCP_SKILLS_SUBDIR` is unset, so nothing changes for
  operators who do not configure Skills. Note that `MCP_AUDIT_SUBDIR` has a
  boot-time assert that it is disjoint from `projects/`, and the Skills subdir
  does not: pointing `MCP_SKILLS_SUBDIR` at `projects/` or an ancestor would
  make every `create_document` fail at runtime with a self-describing error
  rather than at startup. Every documented value is disjoint, and adding the
  assert now would turn a currently-bootable server into one that refuses to
  start, so it is left as a follow-up.

- **Link extraction is linear in body length, so one poisoned note can no
  longer stall every `trace_sources` call.** Both patterns in
  `src/markdownLinks.ts` used negated character classes that accepted the
  pattern's own opening delimiter, so on unterminated input the engine walked
  the tail and threw the work away at every `[` — quadratic, and run over every
  document in the vault on every call. A ~1 MiB body of `[x](` repeated
  extrapolates to roughly 9–15 minutes of blocked event loop; measured at 200k
  characters the base takes 4.6–31.7 s where the replacement takes 0.0–2.3 ms.
  Both extractors are now forward-only `indexOf` scans.

  Recall is unchanged, which matters because `trace_sources` output is derived
  from these functions and the relative-link resolution they feed was itself a
  bug fixed in the P0 slice. Rather than tightening the character classes —
  which would silently drop `[a[b](t)` and `[[[[a]]`, both of which match today
  — the accepted language is preserved exactly and pinned by keeping the
  original regexes in the test file as a reference implementation: the new
  scanners are asserted equal to them over a named corpus, every synthetic
  fixture, seeded random bodies, and an exhaustive sweep of the delimiter
  alphabet. `resolveRelativeLink` is untouched.

- **Front matter is no longer parsed with an engine the document itself
  selects.** `gray-matter` picks its parser from the language tag on the opening
  delimiter (`---js`), and its `javascript` engine's `parse` is a raw `eval()`.
  Vault content is untrusted by design, so a single planted note executed
  arbitrary code inside the server on the always-on read path — every
  `search_documents` / `fetch_document` / `list_projects` / `trace_sources` call
  walks and parses every file. The same engine was reachable from the write
  side: `matter.stringify` re-parses a string argument before serializing, so a
  client-supplied `body` / `new_body` was evaluated during the `plan_*` step,
  which is advertised as non-mutating and therefore precedes any user approval.
  Both call sites, and the one in `src/skillStore.ts`, now pass a hardened
  options object that replaces the `javascript` and `js` engines with a thrower.
  Note that `engines` is **merged** over gray-matter's defaults rather than
  replacing them, so an allowlist of `{ yaml, json }` would leave the dangerous
  engine in place; and `matter.stringify` runs the payload _before_ it throws
  "stringifying JavaScript is not supported", so asserting that an error was
  raised does not prove non-execution. The tests assert non-execution directly,
  via a `globalThis` marker that must stay undefined.

- **A document body can no longer inject keys into the front matter it is
  written with** (INV-2). Because `matter.stringify` re-parsed its string
  argument, a leading `---` YAML block in a client-supplied body was merged into
  the emitted front matter, bypassing `assertFrontmatterPatch` — the only
  server-side field allowlist. `serializeMarkdown` now passes an explicit file
  object so the body is opaque. What decided the merge was not whether a key is
  server-managed but whether the serializer writes it at all: every key present
  in the metadata argument won, so the server-managed `id` and `updated_at` held
  and document identity was never forgeable. (`title` won too, but it is not
  server-managed — it is one of the five keys an approved `frontmatter_patch`
  may set.) What did get through was keys the serializer does not write, such as
  `date:`, which silently changes search ranking through `effectiveTimestamp`.

  A body that begins with a `---` YAML block is now preserved verbatim in the
  body instead of being absorbed into the front matter. Bodies that do not begin
  with `---` serialize byte-identically to before.

### Security

- **`vault.read` is enforced, and the HTTP tool surface is now resolved from the
  token presented on every single request.** Two changes that had to land
  together ([ROADMAP item 2b](./docs/ROADMAP.md)).

  Sessions are gone from the endpoint: one handler serves 2026-07-28 natively and
  2025 through the stateless legacy fallback, so each request of either era gets
  a fresh instance from the same factory. Under the session model, requests were
  routed by `Mcp-Session-Id` **alone** and the presenting principal was never
  re-checked — a connection opened with a write-scoped token kept the write
  surface for its lifetime no matter what token later requests carried. The
  regression test is written as exactly that scenario (one client, one
  connection, the bearer swapped underneath it), because the obvious test — two
  clients with two tokens see two surfaces — passed under the session model too
  and would have proved nothing.

  `vault.read` was not enforced at all. Only the write surfaces consulted the
  token's scopes; the read tools were registered unconditionally and
  `{scopes: []}` is non-null, so a token carrying **no** scope authenticated and
  read the entire vault. That state is reachable without anything going wrong:
  `grantScope` returns requested ∩ grantable and deliberately refuses to
  substitute read for a scope never requested, so a client asking only for
  `vault.write` while writes are off is granted nothing. It was never an
  authentication hole — issuing that token still required the login password —
  but it was the read half of INV-7 item 5 missing.

  Such a request is now **refused** with `403` and the RFC 6750 §3.1
  `insufficient_scope` challenge naming the missing scope, rather than served an
  empty tool list: the challenge is what lets a client re-authorize for the scope
  it lacks, while an empty `200` is indistinguishable from an empty vault and
  sends the operator looking in the wrong place. `surfaceFor` independently
  refuses to build a surface for a principal without read, so a future path that
  bypasses the gate fails closed instead of quietly restoring the hole.

  **The consent page now states the granted scope**, which the previous release
  deliberately withheld — while `vault.read` was unenforced, a scope line would
  have described a restriction the server did not apply. It shows the grant
  (requested ∩ grantable) rather than the request, and says plainly when the
  grant is empty that approving would issue a token which cannot read anything.

  Operationally this also removes the last of the three "the connection dropped"
  causes: there is no session id left to invalidate on restart, so a supervisor
  restart no longer answers `404 unknown_session` until the client
  re-initializes. A restart still drops in-flight requests.

### Added

- **The HTTP endpoint now serves both MCP protocol eras at once** — the 2025
  family and 2026-07-28 — on the new `@modelcontextprotocol/server` v2 package
  line (which pins `@modelcontextprotocol/core` v2 exactly, so it is not
  declared separately)
  ([ROADMAP item 2a](./docs/ROADMAP.md)). Adopted for restart transparency, not
  speed: the 2026-07-28 revision has no `initialize` handshake and no
  `Mcp-Session-Id`, which removes the "connection dropped" cause that a named
  tunnel and `MCP_OAUTH_STATE_FILE` do not address — MCP sessions live in
  process memory, so every restart answers `404 unknown_session` until the
  client re-initializes. Nothing else about that failure changes: a restart
  still drops in-flight requests.

  2025-era traffic keeps the **established sessionful wiring** rather than
  moving to `createMcpHandler`'s stateless legacy default. That default would
  have taken the session model out from under the existing era in the same
  change as the dependency bump; instead `src/httpServer.ts` classifies with
  `isLegacyRequest` — the entry's own classification step, exported as a
  predicate, so the branch cannot disagree with what the handler would have
  decided — and routes 2025 traffic to a sessionful transport as before. Every
  pre-existing HTTP and OAuth boundary test passes **unmodified**, which is the
  claim that the security boundary did not move here. Moving the whole endpoint
  off sessions, and the accompanying re-pin, is ROADMAP item 2b.

  The 2026-07-28 leg has no sessions to resolve scope against, so it resolves
  per request. Both eras call one `surfaceFor(principal, …)`, so the
  scope→tool-surface derivation (INV-6 item 4 / INV-7 item 5) stays a single
  function rather than becoming two. The per-request factory recovers its
  principal from the exact `Request` the endpoint authenticated and **throws if
  it cannot**: there is no default surface to fall back to, because that default
  would be the full one. Pinned by tests that drive a real 2025 client and a
  real 2026-07-28 client against one endpoint and assert the same tool list, no
  session id on the modern leg, and that read-only default, `401`, and the
  DNS-rebinding `403` all still apply to modern requests. The scope gate has its
  own pin in `tests/oauth.test.ts`: a `vault.read` token and a
  `vault.read vault.write` token, back to back against one endpoint on the
  modern era, see two different tool sets — and the read-scoped one still sees
  no write tools afterwards, so the surface follows the presented token rather
  than the first one seen.

  `src/index.ts` (stdio) moves to the v2 `StdioServerTransport` as part of the
  package swap; it still serves one 2025-era instance per connection. Dual-era
  stdio via `serveStdio()` is ROADMAP item 2c.

### Changed

- **DNS-rebinding protection moved off the deprecated transport options to the
  endpoint boundary**, ahead of protocol-era routing, so one check covers both
  eras identically. It had to move: `createMcpHandler` exposes no equivalent
  option, so the modern leg would otherwise have been unprotected. The
  behaviour-pinning tests added earlier are unchanged across the move — same
  requests, same verdicts, different mechanism.

  Two decisions this forced, both recorded in
  [`docs/ROADMAP.md`](./docs/ROADMAP.md):

  - **`MCP_HTTP_ALLOWED_HOSTS` is now compared by hostname, ignoring any
    `:port` suffix** (D-M3A-HOST-PORT). The SDK's `validateHostHeader` is
    port-agnostic; rather than break the env contract, entries are normalized at
    the boundary, so existing `host:port` values keep working and a bare
    hostname now works too. The port was never a useful discriminator — the
    server listens on exactly one port, which is therefore the only port a
    browser could reach it on whatever the allowlist says. A bare IPv6 literal
    is bracketed rather than truncated at its first colon, which would have
    produced an empty, unmatchable entry (and `loadHttpConfig` now brackets an
    IPv6 bind host when building the default for the same reason).
  - **A `Host` header carrying userinfo is refused outright**
    (D-M3A-HOST-USERINFO). Comparing hostnames would accept
    `evil.example@127.0.0.1`, which parses to `127.0.0.1` while naming another
    authority; `Host` has no userinfo field (RFC 9110 §7.2), so no client sends
    one and refusing it costs nothing. Before the check such a request passed
    the allowlist and returned **500** — `new Request()` refusing a URL that
    carries credentials, which is the Fetch spec declining to build an object
    rather than this server declining to serve a request.
  - **`MCP_HTTP_ALLOWED_ORIGINS` keeps exact full-origin comparison, scheme
    included** (D-M3A-ORIGIN-EXACT). The SDK's `validateOriginHeader` is
    hostname-only like its Host counterpart, which for origins would stop
    distinguishing `https://x` from `http://x` — a real relaxation with no
    compensating benefit, so it was not adopted. The absent-`Origin`
    pass-through (D-M1-ORIGIN-ABSENT) and the `/mcp`-only scope of both checks
    are unchanged.

- `@modelcontextprotocol/sdk` v1 is no longer a runtime dependency. It stays as
  a **devDependency**, driving the 2025-era half of the negotiation test from a
  real v1 client rather than a simulation of one.

### Fixed

- **`pnpm typecheck` now covers `tests/`, which it never had.** `tsconfig.json`
  is the build config — its `rootDir` is `src` and it emits declarations — so
  its `include` names `src/**/*.ts` only, and no gate ever type-checked a test
  file. The suite had been constructing `HttpConfig` literals missing the
  required `allowAuditWrite` field at **seven** call sites, invisibly, because
  nothing looked. (They behaved correctly at runtime — a missing flag reads as
  `undefined`, which is falsy, which is the intended "audit surface off" — so
  only the type was wrong. That is exactly the class of error a type-checker is
  for, and exactly the class that goes unnoticed when it is not run.) A new
  `tsconfig.test.json` extends the build config with `noEmit` and adds
  `tests/`, and `typecheck` runs both. `pnpm build` output is unchanged: the
  build config is untouched.

- **The Web-to-Node response bridge honours backpressure.** `res.write`
  returning `false` means the socket buffer is full; the streaming loop read the
  next chunk regardless, so Node queued the pending chunks in memory. A
  held-open 2025-era SSE stream makes that reachable — an authenticated client
  that reads slowly without disconnecting grows the queue for the lifetime of
  the stream. The loop now awaits `drain` before the next read, and a
  disconnect during that wait releases it (once the socket is gone `drain`
  never fires, so waiting on it alone would hang the response instead).

- **The `ctx.requestInfo` identity assumption is now pinned by a test.** The
  modern leg recovers its principal by looking the request up in a `WeakMap`
  keyed by the exact `Request` handed to `fetch`; `McpRequestContext` documents
  that value as "the original HTTP request being served", but that is a
  property of the dependency, and `package.json` floats on a caret range with
  weekly Dependabot bumps. A minor release passing a copy would make every
  modern request fail closed with `unresolved_principal`. Pinning the dependency
  version instead would freeze security patches to buy a guarantee a test gives
  for free — the same trade the DNS-rebinding options already taught. The test
  drives real modern bytes captured off the wire, not a hand-shaped envelope.

### Changed

- **stdio now serves both protocol eras (ROADMAP 2c).** `src/index.ts` hands the
  connection to `serveStdio()` from `@modelcontextprotocol/server/stdio` instead
  of connecting one pre-built server to a `StdioServerTransport`. Before this, a
  local client could only open the 2025 handshake — the endpoint did not offer
  `server/discover` at all — so Claude Code / Codex / Claude Desktop are now free
  to negotiate 2026-07-28 against exactly the same tool factory. The surface is
  unchanged (stdio stays full read + write) and `MCP_ENV_FILE`, transport
  selection and the start-up stderr line are untouched.

  Two options are passed rather than defaulted, each for a measured reason:

  - `legacy: 'serve'` — dual-era serving is the point of the change, so a
    library default that later moved would silently turn 2025-era clients away.
    Flipping it to `'reject'` fails the 2025 leg with `-32022`, which is what
    makes the regression test meaningful rather than merely green.
  - `onerror` — `serveStdio` starts the wire in the background and **drops** the
    rejection when no handler is installed, where the previous
    `await server.connect(…)` would have crashed the process. Without a handler
    a transport that failed to start would leave the "ready" line as the only
    output. It reports the error **class only**: the same callback also receives
    runtime out-of-band errors whose messages can quote inbound bytes, and
    stderr is not a place to echo those. It is non-fatal by design, so malformed
    client input cannot kill the server.

  One instance is pinned per stdio connection, which is what the previous
  release removed from HTTP. The asymmetry is deliberate: on HTTP successive
  requests on one connection can present different bearer tokens, so the surface
  must be re-derived per request; stdio carries no principal at all
  (`serveStdio` never sets `ctx.authInfo`/`ctx.requestInfo`), the peer is the
  process that spawned the server, and the surface is a constant — pinned and
  per-request are observationally identical there. Both eras are driven
  end-to-end by real v1 and v2 clients against the **spawned real entrypoint**,
  so what is pinned is the shipped wiring; reverting the wiring fails both legs.

### Fixed

- **The operations runbook no longer tells operators to reuse a session id that
  no longer exists.** `operations.md` §9 Step 5 documented a manual surface check
  that captured `mcp-session-id` from the handshake and sent it back on the
  `tools/list` call — a step the previous release's sessionless endpoint made
  impossible, left behind in the same change that removed sessions. The
  replacement sends `tools/list` as its own POST, and both it and the `405` on
  `GET`/`DELETE` (the 2025 session operations) are now asserted against the live
  endpoint, so the runbook cannot drift from the server it documents.
- **`operations.md` §1 now lists the third cause of "the connection dropped"**,
  written as resolved: process-memory MCP sessions returning `404
unknown_session` after a restart. A restart is transparent at the protocol
  layer now, and only the OAuth state in §1.B survives it. `context-engineering.md`
  likewise said the tool surface was built "per-session" and described the move
  to per-request in the future tense.

## [0.7.0] — 2026-08-03

### Security

- The OAuth authorization response now carries the RFC 9207 **`iss`**
  parameter, and the authorization-server metadata advertises
  `authorization_response_iss_parameter_supported: true` (MCP SEP-2468,
  authorization-server mix-up defense). Clients that validate `iss` — as the
  MCP spec requires — will now reject a code minted by a different issuer
  before redeeming it. Error paths are unchanged: they deliberately never
  redirect, so the success redirect remains the only response carrying `iss`.

- Force the transitive **`body-parser`** dependency to **`>= 2.3.0 < 3`** via a
  `pnpm.overrides` entry (patched floor, bounded to the express-compatible
  major), clearing GHSA/CVE-2026-12590 (a low-severity DoS where
  an invalid `limit` option silently disabled request-size enforcement). It
  reaches the tree only through `express` (pulled by `express-rate-limit`), and
  the server runs on a raw Node `http` listener — it never mounts express's
  `body-parser` middleware nor passes a caller-controlled `limit` — so the
  vulnerable path was not reachable; this is defense-in-depth that also makes
  `pnpm audit` clean. No source or runtime-behavior change.

### Added

- **Search P0 correctness slice** (first implementation slice of the
  [context-engineering proposal](./docs/context-engineering.md)):
  - **NFKC folding on the search path** (`src/searchText.ts`). Queries and note
    text are folded before matching, so `ＭＣＰ` matches `MCP`, half-width kana
    match full-width, a full-width space separates terms, and a decomposed (NFD)
    body — what macOS filesystems hand back — matches a composed query. This is
    deliberately separate from the NFC path normalization in `pathSafety.ts`,
    which is unchanged: path normalization must preserve identity, search
    normalization is intentionally lossy. Snippets are still sliced from the
    original text, so bodies are returned exactly as written.
  - **`offset` on `search_documents`**, plus `total_count` in the response (see
    _Changed_), giving real paging over ranked results.
  - **`modified_at`, `updated_at`, and `size_bytes` on each search result** —
    `size_bytes` in particular lets a caller notice that a hit is a
    megabyte-scale note before fetching it whole.
- **Search P1 quality slice** (second implementation slice of the
  [context-engineering proposal](./docs/context-engineering.md)). All of it is
  additive: with no new env set and no new parameter passed, ranking and output
  are byte-identical to the P0 slice above.
  - **CJK query segmentation** (`src/searchSegmenter.ts`). A query in a script
    that does not space its words is split into words via `Intl.Segmenter`
    (Node ships full ICU at this package's floor, so no dependency), with a
    character-bigram fallback for small-icu runtimes. `検索エンジン設計` now finds a
    note that says `検索エンジンの設計`, which one substring never could. Sub-terms
    are **added** to the whole token rather than replacing it, so an ASCII query
    tokenizes exactly as before, and a note carrying the phrase verbatim keeps a
    phrase bonus over one holding the pieces scattered. Lone hiragana (particles
    like `の`) are dropped — they occur in nearly every Japanese note and would
    add noise to all of them.
  - **Opt-in recency ranking** — `MCP_SEARCH_RECENCY_WEIGHT` (default **0**,
    i.e. off; 0.25 recommended) and `MCP_SEARCH_RECENCY_HALFLIFE_DAYS` (default
    30), overridable per request with `recency_weight`. The boost is
    **multiplicative**, so it re-orders notes that already matched and can never
    surface one that did not. Age comes from frontmatter `updated_at` / `date`
    before filesystem mtime, because `git clone` rewrites mtime and both the
    vault and the log repo are git-synced.
  - **New filters** on `search_documents`: `path_prefix` (matched against the
    on-disk path, without the `<root>:` prefix), `root`, and
    `updated_after` / `updated_before` ISO 8601 bounds. An unparseable date
    bound is rejected rather than silently ignored.
  - **`order`** — `relevance` / `recent` / `path`. Defaults preserve today's
    behavior: `relevance` with a query, `path` without one.
  - **Two-window snippets.** Up to two passages, chosen to cover distinct query
    terms and joined with `…`; a single window often lands on a passing
    mention while the passage that answers the query sits further down.
  - **`explain`** returns a per-signal `score_breakdown`
    (`title` / `path` / `tags` / `body` / `phrase` / `recency`) that sums to
    `score` — the instrument for tuning weights and measuring the round-trip
    KPI later.
  - **Derived-text cache.** The folded and whitespace-collapsed body is computed
    once when a file is parsed and carried on the cached document, invalidated
    by the same mtime+size signature as the parse. This removes the per-query
    fold of the whole corpus, which was the search path's dominant cost once
    megabyte-scale session archives are in the vault. It is internal: the public
    document projection is an allowlist, so it never reaches a client.
- **Context-engineering proposal (docs only, no runtime change)** —
  [`docs/context-engineering.md`](./docs/context-engineering.md), a
  survey-based design for evolving the read plane from "search API" to
  "context gateway": search correctness/quality slices (NFKC + CJK
  segmentation, recency, filters, pagination), a link-graph module with
  correct relative-link/wikilink resolution, a token-budgeted `get_context`,
  `get_project_state`, section-level `fetch_document`, and an explicit
  reject list (no vector DB / no in-server LLM / no new write surface).
  `docs/ROADMAP.md` gains the matching "Context engineering layer" section
  plus concretized "Search & retrieval UX" slices.
- **`pnpm run check:http` — authenticated two-endpoint surface check**
  (`scripts/check-http.mjs`). Runs the MCP handshake (`initialize` →
  `tools/list`) against each endpoint's local `/mcp` using the bearer read from
  that endpoint's `.env` (never printed), then verifies the live tool surface
  against the same file's `MCP_HTTP_ALLOW_*` flags. It **fails** (non-zero exit)
  when a surface is **wider** than declared — e.g. the unattended scan endpoint
  exposing a general document-write tool — so the interactive/scan separation
  (see `operations.md` §9) is checkable in one command; a surface narrower than
  declared is a warning, not a failure. Accepts repeated `--env <path>` and
  defaults to `./.env` (the interactive endpoint). Packaged under `files` so the
  helper ships with the module.

### Changed

- **BREAKING — `search_documents` returns a counted envelope.** The payload is
  now `{ results, total_count, offset, limit }` instead of a bare array
  (`structuredContent.data.results` rather than `structuredContent.data`).
  Callers that iterated the array directly must read `.results`. Rationale: a
  bare array cannot express "you are seeing 10 of 400", which is exactly what
  makes an agent re-query blindly. The ChatGPT-compatible `search` / `fetch`
  aliases are a frozen contract and are **unchanged**.
- **BREAKING — document responses no longer include `absolutePath`.**
  `fetch_document`, `create_document`, `apply_planned_document_create`, and
  `apply_planned_update` now return a projected document (`toPublicDocument` in
  `src/server.ts`) built from an explicit field allowlist, so the host
  filesystem layout — home directory, vault location — is no longer handed to
  every client. `id`, `relativePath`, `root`, `frontmatter`, `body`, `title`,
  and `stats` are unchanged, and those are what round-trip back into `fetch`.
  The ChatGPT `fetch` adapter never exposed the field.
- Pin the development Node version to **24.13.0** via a new `.node-version` file
  (fnm reads it and auto-switches on `cd`; nvm does not read `.node-version`
  natively — nvm users can run `nvm use "$(cat .node-version)"`), and extend the
  Node.js CI matrix to run the
  full gate on both **22.x** (the `engines` floor) and **24.x** (the pinned dev/
  runtime version). `engines` stays `>=22.12.0` — the server still supports Node
  22+, so this drops no runtime support; it only makes the recommended version
  explicit and keeps it under test alongside the floor.

### Fixed

- **`trace_sources` missed backlinks written as relative Markdown links.**
  Backlink matching compared link text literally against the target's
  vault-relative path, so `[plan](../../claude/planning/connector-plan.md)` —
  the ordinary way to link between folders — never matched. Links are now
  resolved against the linking note's own directory
  (`resolveRelativeLink` in `src/markdownLinks.ts`, applied in both the
  single-root and multi-root stores). Resolution is pure string math compared
  against already-enumerated documents: it never touches the filesystem, a link
  that climbs out of the vault resolves to nothing, and relative links are not
  matched across knowledge roots. Existing literal and wikilink matching is
  unchanged, so this only **adds** previously missing backlinks.
- The synthetic fixture's own cross-folder link was off by one directory level
  (`../` where the target needed `../../`), so it pointed at a path that does
  not exist. Corrected, and the off-by-one is now pinned as its own case — a
  link that climbs too few levels must not be snapped onto the intended target.

## [0.6.0] — 2026-07-18

### Added

- **Constrained audit write surface for an unattended vault scanner**
  (`MCP_AUDIT_SUBDIR` + `MCP_HTTP_ALLOW_AUDIT_WRITE`). A new, independently gated
  pair of tools — `append_audit_report` (create-only report at
  `reports/<run_id>.md`; identical content is an idempotent no-op, different
  content is rejected, existing reports are never overwritten) and
  `compare_and_swap_audit_state` (atomic, sha256 compare-and-swap of `state.md`)
  — lets a scan principal persist audit output into **one reserved vault
  subtree** without holding the general document-write tools. A dedicated
  read-only-plus-audit endpoint (general write off, `MCP_HTTP_ALLOW_AUDIT_WRITE=1`)
  therefore lets an unattended scanner write only audit files, removing the
  confused-deputy exposure of pointing a write-enabled connector at an
  unattended scan. General document writes (`create_document` /
  `plan_document_create` → `apply_planned_document_create` / `plan_document_update`
  → `apply_planned_update`) are separately **forbidden from the audit subtree**
  (INV-9 — audit-trail integrity), so an interactive session cannot forge or
  clobber audit files; audit operations are serialized in-process to keep the
  compare-and-swap race-free. Opt-in and off by default; unset it behaves
  exactly as before (`src/auditStore.ts`, `src/knowledgeStore.ts`,
  `src/config.ts`, `src/server.ts`, `src/httpServer.ts`, `src/index.ts`,
  `src/multiRootStore.ts`, `tests/auditStore.test.ts`,
  `tests/knowledgeStore.test.ts`, `tests/httpServer.test.ts`).
- **Exact-path Markdown creation through a two-step, path-confirmed flow.** New
  `plan_document_create` → `apply_planned_document_create` tools let a client
  create a note at an exact vault-relative `.md` path instead of routing it
  through `projects/<client>/<project>/`. Planning returns the complete-file
  diff and a structured Japanese confirmation question (`はい` plus free-text
  correction); apply requires the caller to echo the exact confirmed path.
  Planning never creates target directories, apply rechecks containment and
  staged-content integrity, and the final `wx` write remains create-only. The
  tools are primary-root-only under multi-root and share the existing document
  HTTP/OAuth write gate (`src/knowledgeStore.ts`, `src/multiRootStore.ts`,
  `src/server.ts`, `tests/knowledgeStore.test.ts`,
  `tests/multiRootStore.test.ts`, `tests/httpServer.test.ts`).

### Changed

- **Vault scans now open Markdown files with bounded concurrency.** A large
  vault (thousands of notes) previously opened every file at once during a
  search/`list_projects`, which could exhaust the process file-descriptor limit
  and surface — especially on iCloud/network-backed folders — as a transient
  `EAGAIN`/`EMFILE` (`Unknown system error -11`). The scan now fans out at most
  `MCP_SCAN_CONCURRENCY` files at a time (default 24), **retries only the
  transient resource-exhaustion codes** (`EAGAIN`/`EMFILE`/`ENFILE`) with
  exponential backoff + jitter, and **skips + logs** any note that fails for a
  non-transient reason (missing/permissions/containment) instead of aborting the
  whole scan (`src/knowledgeStore.ts`, `src/config.ts`, `tests/knowledgeStore.test.ts`).
- **OAuth registrations self-clean.** A client registration that holds no live
  access/refresh token is now pruned once it is older than a grace window
  (default 1h), so repeated connect/reconnect cycles no longer leave dead
  Dynamic-Client-Registration records lingering until the hard client cap. Tokens
  already self-expire; the grace window protects an in-flight registration that
  has not yet completed the token exchange (`src/oauth/store.ts`,
  `tests/oauth.test.ts`).
- **Create-parent handling rejects symlink components before making nested
  directories.** Both routed and exact-path document creates now walk parent
  components one at a time, rejecting symbolic links and non-directories before
  any deeper path can be created (`src/knowledgeStore.ts`,
  `tests/knowledgeStore.test.ts`).

## [0.5.0] — 2026-07-13

### Added

- **Optional OAuth session persistence across restarts**
  (`MCP_OAUTH_STATE_FILE`). By default OAuth state stays in process memory and
  a server restart forces every web client (ChatGPT / Claude.ai) to
  re-authorize; pointing `MCP_OAUTH_STATE_FILE` at a state file makes
  registered clients and tokens survive restarts. Access/refresh tokens are
  stored **as sha256 hashes** in memory and at rest (the file never contains a
  recoverable credential), the file is written atomically with mode `0600`, and
  it carries an **HMAC-SHA256 integrity tag keyed from `MCP_OAUTH_PASSWORD`**
  (scrypt-derived, per-file salt) — a tampered, corrupted, or password-rotated
  state file fails closed to empty state, so rotating the password revokes all
  persisted sessions. Authorization codes remain memory-only (60s, single-use)
  and refresh-token rotation invalidates the old token on disk immediately,
  keeping single-use semantics across restarts (`src/oauth/store.ts`,
  `src/oauth/provider.ts`, `src/config.ts`, `tests/oauth.test.ts`).

## [0.4.0] — 2026-07-12

Adds a **constrained, create-only Skill authoring** surface so a (local or
remote) client can publish instruction-only Skill bundles into the vault without
being granted general document-write access. No breaking changes — a setup that
does not enable the new surface behaves exactly as in `0.3.0`.

### Added

- **Instruction-only Skill creation via a separate two-step flow.** New
  `plan_skill_create` → `apply_planned_skill_create` tools stage and then
  **atomically** publish a Skill bundle — `SKILL.md`, optional flat
  `references/*.md` (≤20), and an optional `agents/openai.yaml` — into a
  pre-existing, vault-relative directory (`MCP_SKILLS_SUBDIR`). The surface is
  deliberately narrow: it is **create-only (never overwrites an existing
  Skill)** and **rejects scripts, binary assets, and arbitrary/nested paths**,
  reusing the existing path-containment guard chain. Like document edits, apply
  runs only against a previously planned bundle the user approved
  (`src/skillStore.ts`, `src/server.ts`, `tests/skillStore.test.ts`).
- **Independent HTTP permission boundary for Skill creation.**
  `MCP_HTTP_ALLOW_SKILL_WRITE=1` exposes only the constrained Skill tools over
  HTTP, **separately from document writes** (`MCP_HTTP_ALLOW_WRITE`), and
  requires `MCP_SKILLS_SUBDIR` (the server refuses to start otherwise). Over
  HTTP the tools are registered only when explicitly enabled and are OAuth
  scope-gated — the session registers just the write surface(s) that are turned
  on — so a remote connector can be allowed to author Skills while general
  document writes stay off (`src/config.ts`, `src/httpServer.ts`,
  `tests/httpServer.test.ts`, `tests/oauth.test.ts`).

### Documentation

- **Operations guide for the Skill surface and macOS deployment.**
  `docs/operations.md` gains a macOS **Tailscale Funnel + launchd** runbook
  (stable `*.ts.net` URL, `KeepAlive` LaunchAgent, stable `node` path, sleep /
  re-Authorize caveats) and an operator walkthrough of the `plan_skill_create` →
  `apply_planned_skill_create` flow (enable flags, create-only / atomic
  guarantees, verification).

## [0.3.0] — 2026-07-07

End-to-end hardening for Claude.ai / ChatGPT web connectors and for real-world
vault data (notably non-ASCII / Japanese notes). No breaking changes to the MCP
tool surface — a `0.2.x` setup upgrades in place. Highlights: read tools now
advertise `readOnlyHint` (far fewer approval prompts on web clients), the OAuth
consent redirect is no longer blocked by its own CSP, the public-endpoint rate
limiter keys on the socket peer instead of a spoofable `X-Forwarded-For`, and
several read-path bugs that broke non-ASCII vaults — or aborted a whole-vault
query on a single bad note — are fixed.

### Changed

- **Read tools advertise `readOnlyHint: true` so Chat clients stop prompting for
  approval on every call.** `search_documents` / `fetch_document` / `list_projects`
  / `trace_sources` and the ChatGPT-compatible `search` / `fetch` aliases are pure
  reads, but without the MCP read-only annotation a client (e.g. Claude.ai) treats
  each call as potentially state-changing and shows an "allow once?" prompt every
  time. They now carry the hint. Write tools (`create_document` /
  `plan_document_update` / `apply_planned_update`) deliberately keep **no**
  read-only hint, so clients still prompt before any mutation
  (`src/server.ts`, `tests/httpServer.test.ts`).

### Fixed

- **HTTP rate limiter now keys on the socket peer, not a spoofable
  `X-Forwarded-For`.** The `/authorize` and `/register` limiter keyed on the
  left-most XFF hop, which every proxy only _appends_ to — so it is fully
  client-controlled. Over a public tunnel that let a caller bypass the limit
  entirely (a fresh spoofed IP per request) and even lock the legitimate user out
  of their own connector by forging _their_ IP. Keying on the (unspoofable) socket
  address makes it a coarse global cap behind a tunnel and naturally per-client on
  a direct bind (`src/httpServer.ts`, `tests/oauth.test.ts`).
- **A single note with a non-string YAML scalar no longer crashes `search` /
  `list_projects` for the whole vault.** YAML auto-types unquoted values, so
  `tags: [2024]` becomes numbers and `client: 2024` a number. Such frontmatter
  parses cleanly (so the fault-tolerant parser never sees an error), but the read
  path then called `tag.toLowerCase()` / `client.localeCompare()` on the value and
  threw — aborting search and list_projects for **every** note, not just the bad
  one. `normalizeMetadata` now coerces `tags` / `source_refs` elements and the
  `client` / `project` scalars to strings at the single read-path chokepoint; the
  write-time field allowlist is untouched (`src/frontmatter.ts`,
  `tests/knowledgeStore.test.ts`).
- **Multi-root: a frontmatter `id` that collides with a root name now fetches the
  note that carries it.** With `KNOWLEDGE_ROOTS`, a vault note whose id begins with
  another root's name + `:` (e.g. `id: "ops:secret"`) was mis-routed by `fetch`
  into that root, returning a **different** document than the one the search
  citation pointed at (or nothing). `MultiRootStore.fetch` now matches a bare id
  against all wrapped documents before treating a `<name>:` prefix as routing
  (`src/multiRootStore.ts`, `tests/multiRootStore.test.ts`).
- **`create_document` keeps non-ASCII (e.g. Japanese) titles instead of collapsing
  them to `untitled`.** The slugifier stripped everything outside `[a-z0-9]`, so an
  all-Japanese `client` / `project` / `title` became empty → `untitled`, letting a
  fully-Japanese vault hold only ONE document per client/project (the 2nd create
  hit the no-overwrite guard). It now keeps Unicode letters/digits (`\p{L}\p{N}`)
  on the NFC-normalized value, with a unique hash suffix for pure-symbol titles
  (`src/knowledgeStore.ts`, `tests/knowledgeStore.test.ts`).
- **`fetch_document` / `fetch` / `trace_sources` now resolve non-ASCII (e.g.
  Japanese) filenames that `search` returns.** Document ids/relative paths derive
  from `fs.realpath`, which on macOS reports filenames **decomposed (NFD)**, while
  `assertRelativePath` normalizes client-supplied paths/ids to **NFC**. The two
  never `===`-matched, so every note with a normalization-sensitive name (most of
  a Japanese vault) came back `Document not found` even though search surfaced it
  — breaking the search→fetch round-trip that Chat clients rely on. `relativeToRoot`
  now returns the identifier in NFC so ids round-trip; both NFC and NFD lookup
  inputs resolve. Path-containment guards are unchanged — containment is verified
  on the raw realpath before normalization, and file I/O still uses the real path
  (`src/pathSafety.ts`, `tests/knowledgeStore.test.ts`).
- **OAuth consent "Authorize" button no longer silently does nothing (Claude.ai /
  ChatGPT web could never finish connecting).** The login page's
  `Content-Security-Policy` used `form-action 'self'`, but a successful login
  redirects (302) back to the client's registered `redirect_uri` on a different
  origin (e.g. `https://claude.ai/api/mcp/auth_callback`). Browsers enforce
  `form-action` against the redirect target of a form submission, so the whole
  submission was refused with no visible error and the authorization code was
  never delivered. The consent form now lists exactly this client's redirect
  origin alongside `'self'` in `form-action` (derived from the already
  exact-match + scheme-validated `redirect_uri`, so the policy stays tight); error
  pages keep the `'self'`-only policy, and the clickjacking/leakage headers
  (`frame-ancestors 'none'`, `X-Frame-Options`, `Referrer-Policy`) are unchanged.
  As part of the same fix, `redirect_uri` registration now rejects wildcard hosts
  (e.g. `https://*/cb`), whose origin (`https://*`) would otherwise widen the
  consent page's `form-action` to every https origin
  (`src/oauth/provider.ts`, `tests/oauth.test.ts`).

## [0.2.1] — 2026-07-07

Public-launch hardening release: a security fix that clears all `pnpm audit`
advisories, read-path and session-archive robustness fixes, and the
community-health files needed to accept outside contributions. No API or
behavior changes to the MCP tool surface — a `0.2.0` setup upgrades in place.

### Added

- **Community-health files** for public contribution: `CONTRIBUTING.md`
  (dev setup, the `pnpm test` quality gate, commit/branch conventions, and the
  "security reports go through SECURITY.md, not issues" rule), a Contributor
  Covenant `CODE_OF_CONDUCT.md`, GitHub issue forms
  (`.github/ISSUE_TEMPLATE/bug_report.yml` / `feature_request.yml` /
  `config.yml`, with blank issues disabled and a security-report contact link),
  and a `.github/PULL_REQUEST_TEMPLATE.md` mirroring the CI quality gate.
- **Actionable private security-reporting channel**: `SECURITY.md` and the issue
  template's security link now point to GitHub private vulnerability reporting
  (draft advisory) instead of only naming the maintainer, so reporters have a
  usable private intake.

### Fixed

- **A single document with unparseable frontmatter no longer breaks every
  query.** `search_documents` / `list_projects` / `fetch_document` /
  `trace_sources` walk and parse every note, so one file with malformed YAML/JSON
  frontmatter (a bare-dash value, or raw control characters that leak in from a
  web clipping) made gray-matter throw and abort the whole operation
  non-deterministically. The read path now parses frontmatter fault-tolerantly
  (`parseMarkdownSafe`): a note that fails to parse is indexed by its body/path
  with empty metadata and a one-line, content-free stderr note, instead of
  poisoning the batch. Path-containment / symlink guards are unchanged
  (`src/frontmatter.ts`, `src/knowledgeStore.ts`, `tests/knowledgeStore.test.ts`).
- **session-archive hook no longer writes invalid YAML frontmatter for a
  detached HEAD.** `archive-session.sh` emitted `branch: -` (bare dash) when
  `git branch --show-current` was empty, which is malformed YAML — this was the
  source of the notes that broke search above. The `branch` value is now quoted
  and escaped like `title` (`branch: "-"`), so freshly archived sessions parse
  cleanly (kept byte-identical with the canonical copy).
- **session-archive masking no longer eats the closing quote of a frontmatter
  value.** The block `mask` ran over the assembled note, so a quoted `title` or
  `branch` whose value contained a `key=…` / `token=…` substring (both are valid)
  had its closing `"` consumed by the mask value pattern, producing malformed
  YAML. The hook now masks every free-text / path-derived frontmatter value
  (`title` / `branch` / `project` / `repos` / `tags`) per-field before quoting
  and masks the body separately, so secrets stay masked (including a checkout
  basename shaped like `token=…`) and the quotes stay intact. Verified for `-`,
  normal names, and `token=…` values (kept byte-identical with the canonical
  copy).

### Security

- **Cleared all `pnpm audit` advisories.** A pnpm `overrides` entry pins the
  transitive `hono` (via `@modelcontextprotocol/sdk` → `@hono/node-server`) to
  `>=4.12.25`, resolving 6 advisories (1 high — CORS middleware reflecting any
  origin with credentials under a wildcard default — plus 5 moderate). The
  refreshed lockfile also moves `gray-matter`'s transitive `js-yaml` to `3.15.0`
  (within its existing range), clearing a moderate merge-key quadratic-DoS
  advisory without the gray-matter-breaking jump to `js-yaml` 4.x. `pnpm audit`
  is now clean and the 86 tests still pass.

## [0.2.0] — 2026-07-05

Second release. The headline change is **multi-root knowledge access**; the rest
is developer-facing hook tooling (session archiving, command-learning logs),
documentation, and dependency/CI maintenance. No breaking changes — a single
`KNOWLEDGE_ROOT` setup behaves exactly as in `0.1.0`.

### Added

- **Multiple knowledge roots** (`KNOWLEDGE_ROOTS="name=/path,…"`): search,
  fetch, list, and trace across several repos at once. The first root is the
  primary (writable); every additional root is strictly read-only and its
  documents are addressed as `name:relative/path` (results carry a `root`
  field). Single `KNOWLEDGE_ROOT` behavior is unchanged. Each root keeps the
  full path-containment guard chain; overlapping roots are rejected at startup
  (`src/multiRootStore.ts`, `tests/multiRootStore.test.ts`).
- **session-archive hook** (`.claude/skills/session-archive/`): Stop/SessionEnd
  hook that renders the full Claude Code session transcript (title +
  conversation + tool calls/results, secrets masked with the ops-logging rules)
  into one Markdown note per session inside the private vault clone and pushes
  it, making session history searchable through this MCP server. The vault is
  located indirectly (`SESSION_VAULT_REPO` env or a `.claude-session-vault`
  marker); no private repo name or path is committed here. No-op without a
  vault clone. Adds a **PreCompact snapshot mode**: before auto-compact prunes
  a transcript, a full-detail snapshot is written under
  `_logs/ClaudeCode-Web/_precompact/` so pre-compact content is never lost.
- **ops-logging skill + hooks** (`.claude/skills/ops-logging/`): PostToolUse/Stop
  hooks that append a "command + intent" learning log (all secrets masked;
  `Bearer <token>` masked as a unit; GitHub MCP calls recorded via a
  metadata-only allowlist) and push it once per session to a separate private
  `terminal-ops-logs` repo. No-op unless `OPS_LOG_REPO` points at a clone.
- **MIT `LICENSE`** file and a `license` field in `package.json`.
- **Manual release workflow** (`.github/workflows/release.yml`):
  `workflow_dispatch` → `gh release create`, refusing to overwrite a
  pre-existing tag.
- **Documentation**: operations guide (`docs/operations.md`, incl. Cloudflare
  account/domain requirements, systemd full-hardening drop-in, and a bwrap
  sandbox recipe for the stdio server), `docs/ROADMAP.md`, a STRIDE
  `docs/threat-model.md`, bilingual PR/FAQ (`docs/PRFAQ.md`, `docs/PRFAQ.en.md`),
  and README polish (architecture Mermaid diagram, status badges, use-cases).

### Changed

- `KnowledgeStore` is now composed behind a multi-root layer; `search`,
  `chatgpt` aliases, `config`, and result `types` were adapted to carry an
  optional `root` and to resolve `name:relative/path` addresses.
- Dependency maintenance (dev toolchain): `@types/node` → `^26`, `eslint`
  → `^10.6`, `oxlint` → `^1.71`, `prettier` → `^3.9`, `typescript-eslint`
  → `^8.62`, `vite` → `^8.1`, `vitest` → `^4.1.9`, plus a `github-actions`
  group bump. `CLAUDE.global.md` re-synced byte-identical with the canonical
  global layer.

## [0.1.0] — 2026-06-09

First tagged release. MCP server exposing a private Markdown vault
(`KNOWLEDGE_ROOT`) over two transports:

### Added

- Add oxlint as a fast correctness pre-pass before ESLint, typecheck, build, and tests.

- **stdio transport** for local CLI/desktop clients (Claude Code, Codex, Claude
  Desktop) with the full tool surface.
- **Streamable HTTP transport** for remote Chat connectors, hardened with bearer
  auth (constant-time, fail-closed), loopback bind, DNS-rebinding protection,
  request-body cap, and a read-only tool surface unless `MCP_HTTP_ALLOW_WRITE=1`.
- **OAuth 2.1 authorization server** (opt-in) for ChatGPT / Claude.ai web:
  metadata discovery, dynamic client registration, PKCE S256, authorization-code
  - refresh-token grants, scrypt login gate, scope enforcement
    (`vault.read` / `vault.write`), RFC 8707 audience binding, and consent-page
    clickjacking headers.
- Coarse per-client **rate limiting** on the public OAuth endpoints
  (`/authorize`, `/register`), and **ESLint + Prettier** with `lint` / `format` /
  `format:check` scripts wired into CI.
- Search **parse cache** (mtime/size-invalidated) in `KnowledgeStore` so queries
  no longer re-parse unchanged Markdown files on every call.
- Tools: `search_documents`, `fetch_document`, `list_projects`, `trace_sources`,
  `create_document`, `plan_document_update` → `apply_planned_update` (two-step,
  stale-safe writes), and ChatGPT-compatible `search` / `fetch` aliases.
- Security invariants pinned by tests: path containment, symlink-escape/cycle,
  frontmatter allowlist, two-step stale-safe writes, HTTP auth + read-only
  surface, and the full OAuth flow.

[Unreleased]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/theosera/claude_openai_mcp_connector/releases/tag/v0.1.0
