# Redaction corpus

Synthetic inputs for the log redactor (#249). Every value is made up: the secrets are marker words such as `SUFFIX_MUST_GO`, not credentials.

## `corpus.jsonl`

179 cases, one JSON object per line. The fields are:

- `id` and `section`: the case's name and the group it belongs to.
- `kind`: `command` or `text`, the input kinds `packages/log-redaction/src/policy.mjs` declares.
- `multiline` and `fence`: whether the input has more than one line, and whether it contains a Markdown code fence.
- `input`: the text given to the redactor.
- `secrets`: words that must not appear in the output. Count them after replacing every `***MASKED***` with a delimiter, because a secret word can occur inside the mask token itself. Replace it rather than remove it: removing it joins the text on either side into a word that is not in the output.
- `preserve`: words that must still appear in the output. It does not rule out every over-mask. For example, the shipped sed `mask()` (capture-command.sh as of 550ec24) already turns `mysql and later -price list` into `mysql and later -p***MASKED*** list` through its `mysql … -p` rule, whether a quote is left open or not. Case A-F1c's rule (when a quote is not closed, mask the union) keeps it that way, and no `preserve` word requires otherwise.
- `baseline`: what the sed `mask()` at `rev` did to the input. `rev` is `965df52` for every case, which is before #250.
  - `leaked`: the secrets it left in the clear.
  - `broken`: the preserve words it removed.
- `regressed_on`: the revisions on which the case got worse, each as `{rev, leaked, broken}` like `baseline`.

The file is derived from the review corpus as of 2026-10-01 20:33 JST (67,045 bytes, sha256 prefix `b288aa62a08b2d53`), except case O-3. Section N, added at 08:48 JST, holds keys quoted inside a quoted argument (JSON in `curl -d '{…}'`, a dict in `python3 -c "…"`) and a quoted search term as a control.

Section O, added at 20:33 JST, holds marker words that end in a label word. #262 has the fuzz generator draw such words again, so the fuzz does not produce these shapes; they are kept here instead:

- O-1 and O-2: a quoted passphrase whose first word ends in `KEY`, in double and single quotes. The sed `mask()` reads the end of that word as a label: it masks the second word, takes the closing quote with it, and the quoted-passphrase rule no longer applies, so the first word is left in the clear (`baseline.leaked`). The core masks both words.
- O-3 is left out: a URL whose user name ends in `KEY`. Both the sed `mask()` and the core read the end of the user name and the colon as a label, and mask the host's preserve word (#261). It would fail the core's corpus check today, so it comes in with the fix for #261.

Section P holds #276's label-element attribute values and labels after unquoted values ending in a closing brace, bracket or parenthesis, in both input kinds. Its controls keep non-label attributes readable and mask closing delimiters inside a secret when no label follows. The sed baseline for these 32 additions was measured from revision `965df52`, like the earlier sections.

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
