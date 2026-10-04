# Redaction corpus

Synthetic inputs for the log redactor (#249). Every value is made up: the secrets are marker words such as `SUFFIX_MUST_GO`, not credentials.

## `corpus.jsonl`

217 cases, one JSON object per line. The fields are:

- `id` and `section`: the case's name and the group it belongs to.
- `kind`: `command` or `text`, the input kinds `packages/log-redaction/src/policy.mjs` declares.
- `multiline` and `fence`: whether the input has more than one line, and whether it contains a Markdown code fence.
- `input`: the text given to the redactor.
- `secrets`: words that must not appear in the output. Count them after replacing every `***MASKED***` with a delimiter, because a secret word can occur inside the mask token itself. Replace it rather than remove it: removing it joins the text on either side into a word that is not in the output.
- `preserve`: words that must still appear in the output. It does not rule out every over-mask. For example, the shipped sed `mask()` (capture-command.sh as of 550ec24) already turns `mysql and later -price list` into `mysql and later -p***MASKED*** list` through its `mysql … -p` rule, whether a quote is left open or not. Case A-F1c's rule (when a quote is not closed, mask the union) keeps it that way, and no `preserve` word requires otherwise.
- `baseline`: what the sed `mask()` at `rev` did to the input. `rev` is `965df52` for sections A–P (before #250), `38f2306abbc2b74f4f648bbaf8dcaa3125a8e705` for section Q, and `ae2291fd94a97ab992446901b5e707b575e9b5cd` for section R.
  - `leaked`: the secrets it left in the clear.
  - `broken`: the preserve words it removed.
- `regressed_on`: the revisions on which the case got worse, each as `{rev, leaked, broken}` like `baseline`.

The file is derived from the review corpus as of 2026-10-01 20:33 JST (67,045 bytes, sha256 prefix `b288aa62a08b2d53`), except case O-3. Section N, added at 08:48 JST, holds keys quoted inside a quoted argument (JSON in `curl -d '{…}'`, a dict in `python3 -c "…"`) and a quoted search term as a control.

Section O, added at 20:33 JST, holds marker words that end in a label word. #262 has the fuzz generator draw such words again, so the fuzz does not produce these shapes; they are kept here instead:

- O-1 and O-2: a quoted passphrase whose first word ends in `KEY`, in double and single quotes. The sed `mask()` reads the end of that word as a label: it masks the second word, takes the closing quote with it, and the quoted-passphrase rule no longer applies, so the first word is left in the clear (`baseline.leaked`). The core masks both words.
- O-3 is left out: a URL whose user name ends in `KEY`. Both the sed `mask()` and the core read the end of the user name and the colon as a label, and mask the host's preserve word (#261). It would fail the core's corpus check today, so it comes in with the fix for #261.

Section P holds #276's label-element attribute values and labels after unquoted values ending in a closing brace, bracket or parenthesis, in both input kinds. Its controls keep non-label attributes readable and mask closing delimiters inside a secret when no label follows. The sed baseline for these 32 additions was measured from revision `965df52`, like the earlier sections.

Section Q holds #295's five selected shapes in both input kinds: three compound names, a namespaced label, a password input, a start tag across lines, and both angle characters inside a later quoted attribute. Synthetic words replace the Issue table's ellipses. It also includes the owner-approved unquoted self-closing password input, `<input value=SENSITIVE295 type=password/>`, in both kinds. That form also leaked on the previous PR head `e9b6e917`. All 18 section-Q baselines were executed against the freshly fetched `38f2306` mask. Every case keeps the word after the element. The separate named tests preserve #291's known core gaps rather than treating them as regressions or fixing that excluded issue. The committed fuzz sample contains no `<`, so passing it does not exercise these markup rules.

The named #295 fence tests also run the archive composition (renderer → append one LF → mask → refence). They pin structural fence runs, line positions, count and parity while requiring credential masking on the same lines, and reject exposed forged user turns. Core command/text and both hook copies have separate fence and extent tests. The new markup reader allows at most 32 physical lines, including the opening line; LF, CRLF and bare CR each count as one separator. Core direct text and closing-tag whitespace share that budget. Two-line tags remain supported. The ceiling of 32 is a log-safety choice, not an XML limit: it allows the opening line and 31 continuations while bounding how far a malformed tag can affect later prose. Beyond it, new markup recognition stops and existing fallback readers retain their own behavior. The legacy exact-label hook fallback is handled separately: after 32 physical lines it enters an opaque masking state without parsing attributes or buffering the rest of the candidate. The new compound-label bound tests and the legacy exact-label masking-floor tests pin these distinct behaviors.

The former `cdef00b` whole-line fence protection was rejected: appending marker-like text could exempt an otherwise maskable credential, and resetting markup context at a fence could expose continuation values. Its passing tests and disclosed reduced coverage did not make that acceptable. Section R commits 20 regression cases (ten inputs in both kinds) covering inline marker suffixes, opening info strings, Bearer/provider values, quoted values across inline runs, and credentials on neighboring bare-CR segments. Both hook baselines were executed on `ae2291f` and the regressing `cdef00b`; existing 197 corpus records are unchanged. The committed fuzz sample contains neither `<` nor literal `&lt;`, so its success does not exercise this rule.

The replacement reads credentials without fence-based exemptions or context resets. Only a line-leading fence run with up to three spaces, or a conservative indentation/container/list prefix, is structural. Arbitrary inline marker runs may be removed with the secret value. Prefix/run syntax, closing whitespace and physical separators survive. Ordered-list ordinal digits in an accepted structural prefix are normalized to fixed zeroes of the same width, so a credential cannot be restored through list-number syntax; this also changes benign list numbers. Backtick runs with later backticks in their info are not structural candidates. They retain ordinary masking, followed by the archive wrapper's existing refence handling when masking creates a valid opener. Credential-bearing info text is always eligible for masking.

Core clips merged masking spans against those syntax spans after collecting credentials from the full original input. Its omission paths retain syntax and separators only, never raw info strings. The hooks carry syntax-only metadata alongside records that all traverse the ordinary masking rules and continuous markup reader. On structural fence segments, the hook result conservatively masks all non-syntax info, including benign language names or prose. Other CR-separated segments use their normally masked result when the segment counts agree. If a legacy rule consumes CR separators, the hook restores the syntax-only skeleton of that LF record; this also overmasks unrelated content in its other CR segments. It never restores original sensitive text to align the outputs. This fallback cost is separate from a masking bypass. Continuous credential context can also mask a generated archive heading when an unfinished selected attribute extends through that heading to a later `>`; the renderer containment tests still require the tool fences and reject exposed forged turns.

The final legacy hook fallback counts CR separators within each exact-label candidate, so unrelated CR segments cannot exempt a short malformed tag. At the attempted 33rd physical line it masks the legacy candidate opaquely through its next angle delimiter or the LF record end, preserving separators and the text after a closing `>`. This also masks an unterminated overbound legacy tail that main could leave readable. Fixed nonsecret probes retain the ambient sed locale’s whitespace and case-insensitive ASCII-equivalent classifications, including accepted Unicode spellings. Core's preexisting generic quoted-value lexer stops at a physical line ending: some bare-CR continuation values that the hooks mask remain a known core baseline gap, rather than a reason to expand that lexer in this change. Hook-specific tests retain those stronger hook expectations.

The committed `fence-matrix.json` adds 185 explicit synthetic inputs per engine: nine common credential spellings across nine marker placements, two provider families across those placements, nine legacy argument spellings across them, and five reported examples. Its 746 tests include scope controls and measured per-engine allowances from immutable main `ae2291f`; the same tests produced 436 intended failures on `cdef00b`. The local placement definitions are recorded in the fixture and are not claimed to reproduce an unavailable external probe verbatim. Both hook copies retain exactly the nine preexisting `/```|~~~/!` sed-address exclusions in identical bytes and order. Those existing argument-family gaps are distinguished from regressions; core has no matching whole-line exclusions.

The performance test's long multiline-tag family uses two physical lines; its former thousands-of-lines form is outside the explicit bound. Separate workloads exercise structural markers, recovery after the line limit, long invalid backtick info and credential-bearing marker lines, with the unchanged grouped threshold of 9. Prior plaintext-preservation assertions inside selected credential values are replaced with credential-masking assertions under the corrected contract; line structure, following public text outside the selected value, original five shapes and the 32-line limit remain independently checked.

The hook markup pass also masks attribute-free plist key names: `<key>CFBundleIdentifier</key>` becomes `<key>***MASKED***</key>`, whereas the `38f2306` hook baseline preserves that key name. A following line `<string>com.example.demo</string>` remains unmasked as before. This is measured overmasking of the key name, not support for masking the following plist string value; command and text inputs share this hook behavior.

The file keeps only the fields above. Two kinds of field are left out:

- Provenance (`source`, `origin`, `note`, `measured_by_80`), which points at files outside this repository.
- Fields only some cases carry, which no check here reads yet: `syntax`, `redact_spans`, `preserve_spans` and `expected_output` (section H), and `fixed_on`.

The derivation is:

```python
keep = ["id", "section", "kind", "multiline", "fence", "input", "secrets", "preserve", "baseline", "regressed_on"]
for row in source_rows:
    if row["id"] == "O-3":  # a known over-mask of the core (#261); it comes in with that fix
        continue
    out.write(json.dumps({k: row[k] for k in keep}, ensure_ascii=False) + "\n")
```

## `perf-I.json`

The timing spec, copied unchanged (4,072 bytes, sha256 prefix `a90effba1758a6c8`):

- **Input sizes:** 64, 128 and 256 KiB.
- **Pass:** doubling the input size must take at most 2.5 times as long.
- **Measured values:** from macOS, not from CI.

Nothing reads either file yet except the checks in `tests/logRedactionPolicy.test.ts`.
