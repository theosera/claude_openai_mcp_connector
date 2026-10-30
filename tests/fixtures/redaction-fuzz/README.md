# Redaction fuzz

Generated inputs for the differential fuzz of the log redactor (#249). The generator is `tests/tools/redactionFuzz.ts`; this directory holds one committed sample of its output.

## `seed-1.jsonl`

490 cases from `generate(1, 490)`: ten of each of the 49 families, in turn. `tests/redactionFuzz.test.ts` regenerates it and requires the same bytes, so a change to the generator that changes these 490 cases shows up as a change to this file. The ten families added for #280 changed the index-to-family assignment and random draws, and `dash-armor` gained an immediate preserve word. #296 adds another 20 families, changing that assignment and the random draws again. Full runs from either earlier grammar are not reproduced case by case. A change that only reaches later cases need not change the sample: when the label redraw below was introduced with 19 families, it left the then-190-case sample as it was, while seed 1 differed from case 5139 on (seed 13 from case 8216). Those positions describe the old grammar, not this 49-family version.

Each line has the corpus fields a judge reads, plus the case's origin:

- `id`: `FZ-s<seed>-<index>`.
- `family`: the shape the case was built from, such as `mysql-p`, `yaml-doubled` or `prose-apostrophe`.
- `seed`: the seed it came from.
- `kind`: `command` or `text`.
- `input`: the text given to the redactor.
- `secrets`: marker words that must not be readable in the output. Each is `FK` followed by 8 characters, at least one of them a digit.
- `preserve`: marker words that the output must keep as many copies of as the input has. Each starts with `KEEP` followed by 6 characters. In the port families, a host marker also includes `.example.test:<port>` so that losing just the port is a broken preserve marker, even if the generated word survives.

Every marker is in its input, none is part of another marker, and none is part of the mask token `***MASKED***`. The generator refuses a case that breaks one of these rules, and the judge refuses it again.

No marker ends with a label (`SECRET_LABELS` in `packages/log-redaction/src/policy.mjs`; with the markers' alphabet that means KEY, PAT or BEARER): the generator draws such a word again, the way it draws again a word without a digit. Neither the core nor the sed `mask()` needs a word boundary before a label, so a user name ending in KEY before `:`, or a secret ending in PAT before a blank, is read as a label by both, and the preserve word after it is masked as its value.

- Such a case changes no column that fails the run, since the reference does the same. It only moves cases in and out of `main_broken` and `fixed`.
- The redraw is there for this sample: `tests/logRedactionCorpus.test.ts` judges it against the core alone, so a regenerated sample must not go red for this reason.
- The shapes the redraw takes out of the fuzz, including one in which the sed `mask()` leaks a secret, belong in the corpus as fixed cases instead (#261).
- The tests check KEY and PAT endings. No seed they run makes a word ending in BEARER, so that part of the redraw is not reached by them.

## Corpus L and M coverage

The original `url-userinfo` (L-1) and `dash-armor` (M-4, with M-1's five-dash value) remain. Ten new families give each requested shape its own name and ten committed cases:

| Corpus | Family                    | Kind    | Shape                                                                                  |
| ------ | ------------------------- | ------- | -------------------------------------------------------------------------------------- |
| L-2    | `url-userinfo-dash`       | command | A dash between two secret markers in a URL password                                    |
| L-3    | `url-userinfo-pair`       | command | Two URLs with independent users, passwords and hosts on one line                       |
| L-4    | `url-userinfo-quoted`     | command | A quoted URL followed by `next=<preserve>`                                             |
| L-5    | `url-user-only`           | command | User without a password; no secrets, user/host/path must survive                       |
| L-6    | `url-port-only`           | command | No userinfo; no secrets, host plus port and path must survive                          |
| L-7    | `url-userinfo-port`       | command | PostgreSQL userinfo, host plus port, then a path                                       |
| M-2    | `passwd-dash-followed`    | text    | Quoted five-dash passwd value followed by `next=<preserve>`                            |
| M-3    | `passphrase-dash-quoted`  | command | Quoted passphrase holding a blank and five dashes, followed by a preserve word         |
| M-5    | `passwd-dash-certificate` | text    | Quoted five-dash passwd value and a certificate marker on the same line                |
| M-6    | `passwd-armor`            | text    | Quoted passwd without dashes, private-key block, then a preserve word on the next line |

All M families, including the existing `dash-armor`, place a preserve word immediately after the quoted value; block families also keep a word after the block. Quoted families draw both quote directions. L-6 draws ports 8443/8080 and L-7 draws 5432/5433. These negatives measure over-masking independently of secret leakage; they do not relax the judge or the core-only sample gate.

## Label and markup coverage (#296)

Each row below has a `-command` and a `-text` family, with ten sample cases per family. The original 29 families keep their order; the ten command families follow, then the ten text families. A preserve word sits immediately before and after every new shape. Every credential value has a secret marker, including values the current core fails to hide.

| Family stem                  | Shape                                                                                            | Reference   |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ----------- |
| `delimiter-label`            | Unquoted password, closing `}` or `]`, then token/Bearer and another secret; text also draws `)` | #276        |
| `label-element-attributes`   | Same-line closed password/token element, quoted and bare attributes, empty or secret body        | #276        |
| `label-attributes-unclosed`  | Two attributes without a closing tag                                                             | #291 / #293 |
| `label-attributes-child`     | Two attributes followed by a child value                                                         | #291 / #293 |
| `label-attributes-next-line` | Two attributes and direct text, with the closing tag on the next line                            | #291 / #293 |
| `compound-label-element`     | `access_token`, `api_key` or `client_secret`, two attributes and direct text                     | #295        |
| `namespaced-label-element`   | `ns:password`, two attributes and direct text                                                    | #295        |
| `password-input`             | Password input with quoted/bare values, case variation, reordered type/value, self-closing end   | #295        |
| `multiline-label-start`      | Simple label start tag split between attributes                                                  | #295        |
| `angled-label-attribute`     | `<` or `>` inside the second quoted attribute, followed by another attribute and direct text     | #295        |

Quoted attributes draw both quote directions. The two line-spanning shapes draw LF and CRLF. A command `)` is excluded from `delimiter-label-command` because it already ends a shell word without the #276 fix; it would not discriminate that fix.

The coverage tests check input shapes and marker counts independently of `FAMILY_NAMES`. Matching core rollbacks must expose an additional generated secret, rather than merely change formatting. For the three #291 shapes, both shipped sed copies are tested with two overlapping attribute paths removed: the #295 streaming simple-label path and the older #293 cleanup. Removing only the cleanup leaves the newer path active and is not evidence that the grammar misses the shape. Mutants are constructed in memory; tracked engine files are not edited.

At integration base `4178facf55caf54de82f3382b9835425dc5f6656`, the core still leaks later attribute values in all three #291 shapes, and can also leak child/direct text. The generated cases retain those secrets. They are findings for the core owner, not new argument-position exceptions. This grammar update does not change the judge, suppress failing cases, or relax the core-only sample gate. The core owner supplies the companion corpus-test commit: its fixed values change from 290/29/no-`<` to 490/49/180 markup inputs in the same D1 PR. The strict gate still rejects all 60 #291 sample cases until C4 fixes them. Acceptance and merge wait for C1 → C2 → C3 → C4 in the owner-approved order; no case or exception is removed or added to bypass that dependency. D1 edits only its generator, generator tests and sample/README, and imports the core-authored corpus-test commit without independently editing that file.

## How cases are judged

`tests/tools/redactionJudge.ts` judges one case on three axes:

- `leaked`: secret words still readable in the output. Each `***MASKED***` is replaced with a NUL before searching, for the reason given in `../redaction-corpus/README.md`.
- `broken`: preserve words the output has fewer copies of than the input. Counting, rather than asking whether the word is present, catches an output that keeps one copy of a word the input had twice. The shipped sed `mask()` does this to corpus case B-N1.
- `omitted`: the engine dropped the body. Its text is still searched for secrets.

## Full runs

The committed sample is small so that `pnpm test` stays fast. The acceptance runs use several seeds with at least 16,000 cases each. The engine reads one `{"text": …, "kind": …}` per line, so it has to be the core's command line; the shared engine's CLI reads bare strings:

```sh
pnpm exec tsx tests/tools/redactionFuzz.ts --seed 13 --count 16000 \
  --engine "node packages/log-redaction/src/cli.mjs"
```

`--seed` is required and takes 0 to 4294967295, the generator's 32-bit state. `--count` takes 1 to 9007199254740991 (the largest safe integer) and defaults to 16000. Both are read as decimal digits only, and `--engine` needs a value. Each option is written `--name value` and at most once; any other argument, such as `--count=16000` or a misspelt name, is invalid. The runner checks all of this before it starts any engine. An invalid argument exits 2 with nothing on stdout, because a run that generated no cases would otherwise report no red columns and exit 0.

The runner compares the candidate engine with both shipped copies of `mask()` (the capture hook and the archive hook), one as the reference and then the other. For each reference it prints one JSON line with these counts:

| Column          | Meaning                                                              | Fails the run                  |
| --------------- | -------------------------------------------------------------------- | ------------------------------ |
| `new_leaked`    | the sed `mask()` hid a secret and the candidate does not             | yes                            |
| `new_broken`    | the sed `mask()` kept a preserve word and the candidate does not     | yes                            |
| `copy_mismatch` | the two sed copies give different outputs for the case               | yes                            |
| `main_leaked`   | both leave a secret readable: the sed `mask()`'s own leak            | no, but it is not an allowance |
| `main_broken`   | the sed `mask()` itself removed a preserve word: its own over-mask   | no, reported for reference     |
| `fixed`         | the sed `mask()` leaves a secret readable and the candidate hides it | no                             |
| `omitted`       | the candidate dropped the body                                       | not decided yet                |

Each column also has a `<column>_by_family` map, and `cases_by_family` records the denominator for every family. A family missing from a column map has zero cases in that column; columns can overlap, so their sum need not equal the case count.

Whether `omitted` cases can count toward a pass is a decision about the pass condition, and it has not been made.

The run exits 1 when a column that fails the run is non-empty for either reference, and 2 when the run itself fails. A run is only valid when it printed two lines, one for `capture` and one for `archive`, each with `cases` equal to the requested count. Exit 0 alone does not show that.
