# Redaction fuzz

Generated inputs for the differential fuzz of the log redactor (#249). The generator is `tests/tools/redactionFuzz.ts`; this directory holds one committed sample of its output.

## `seed-1.jsonl`

170 cases from `generate(1, 170)`: ten of each of the 17 families, in turn. `tests/redactionFuzz.test.ts` regenerates it and requires the same bytes, so a change to the generator shows up as a change to this file.

Each line has the corpus fields a judge reads, plus the case's origin:

- `id`: `FZ-s<seed>-<index>`.
- `family`: the shape the case was built from, such as `mysql-p`, `yaml-doubled` or `prose-apostrophe`.
- `seed`: the seed it came from.
- `kind`: `command` or `text`.
- `input`: the text given to the redactor.
- `secrets`: marker words that must not be readable in the output. Each is `FK` followed by 8 characters, at least one of them a digit.
- `preserve`: marker words that the output must keep as many copies of as the input has. Each is `KEEP` followed by 6 characters.

Every marker is in its input, none is part of another marker, and none is part of the mask token `***MASKED***`. The generator refuses a case that breaks one of these rules, and the judge refuses it again.

## How cases are judged

`tests/tools/redactionJudge.ts` judges one case on three axes:

- `leaked`: secret words still readable in the output. Each `***MASKED***` is replaced with a NUL before searching, for the reason given in `../redaction-corpus/README.md`.
- `broken`: preserve words the output has fewer copies of than the input. Counting, rather than asking whether the word is present, catches an output that keeps one copy of a word the input had twice. The shipped sed `mask()` does this to corpus case B-N1.
- `omitted`: the engine dropped the body. Its text is still searched for secrets.

## Full runs

The committed sample is small so that `pnpm test` stays fast. The acceptance runs use several seeds with at least 16,000 cases each:

```sh
pnpm exec tsx tests/tools/redactionFuzz.ts --seed 13 --count 16000 \
  --engine "node .claude/skills/_shared/redact-log.mjs"
```

The runner compares the candidate engine with both shipped copies of `mask()` (the capture hook and the archive hook), one as the reference and then the other. For each reference it prints one JSON line with these counts:

| Column          | Meaning                                                              | Fails the run                  |
| --------------- | -------------------------------------------------------------------- | ------------------------------ |
| `new_leaked`    | the sed `mask()` hid a secret and the candidate does not             | yes                            |
| `new_broken`    | the sed `mask()` kept a preserve word and the candidate does not     | yes                            |
| `copy_mismatch` | the two sed copies give different outputs for the case               | yes                            |
| `main_leaked`   | both leave a secret readable: the sed `mask()`'s own leak            | no, but it is not an allowance |
| `fixed`         | the sed `mask()` leaves a secret readable and the candidate hides it | no                             |
| `omitted`       | the candidate dropped the body                                       | not decided yet                |

Whether `omitted` cases can count toward a pass is a decision about the pass condition, and it has not been made.
