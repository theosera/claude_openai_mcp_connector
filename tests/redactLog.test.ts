import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MASK,
  applySpansOnce,
  collectArmorSpans,
  collectCredentialSpans,
  collectProtectedSpans,
  defaultVocabulary,
  mergeOverlaps,
  omitted,
  redactFragments,
  redactText,
  RedactionOmitted,
  EXPECTED_SCHEME_WORDS,
  SHIPPED_MASK,
  vocabularyFrom,
  assertUsableVocabulary,
  withoutProtected
} from "../.claude/skills/_shared/redact-log.mjs";

/**
 * Unit tests for the span machinery, separate from the acceptance tests in
 * `logRedactor.test.ts`. This file pins the property that replaces the old
 * rule-ordering pins: the two collectors read the same original text, so their
 * order cannot change the result.
 *
 * The old suite pinned "the PEM range rule runs before the token-shape rules".
 * That pin went vacuous once, silently, when an unrelated change moved which
 * rule matched `PRIVATE KEY` first -- and it stayed green while the rules were
 * in an order that leaked 3 of 3 body lines. Order-independence cannot go
 * vacuous the same way: there is no order to get wrong.
 */

const span = (start: number, end: number, kind = "test") => ({ start, end, kind });

describe("mergeOverlaps", () => {
  it("keeps disjoint spans apart and sorts them", () => {
    const merged = mergeOverlaps([span(10, 14), span(0, 4)], 20);
    expect(merged.map(({ start, end }) => [start, end])).toEqual([
      [0, 4],
      [10, 14]
    ]);
  });

  it("folds overlapping spans into one", () => {
    const merged = mergeOverlaps([span(0, 6), span(4, 10)], 20);
    expect(merged.map(({ start, end }) => [start, end])).toEqual([[0, 10]]);
  });

  it("absorbs a contained span without shrinking the outer one", () => {
    const merged = mergeOverlaps([span(0, 20), span(5, 9)], 20);
    expect(merged.map(({ start, end }) => [start, end])).toEqual([[0, 20]]);
  });

  it("merges touching spans, so one run does not emit two masks", () => {
    // `[0,4)` and `[4,8)` describe a single run. Left apart they would produce
    // `***MASKED******MASKED***`, which reads as two findings where there is one.
    const merged = mergeOverlaps([span(0, 4), span(4, 8)], 20);
    expect(merged.map(({ start, end }) => [start, end])).toEqual([[0, 8]]);
  });

  it("records which collectors claimed a merged run", () => {
    const merged = mergeOverlaps([span(0, 6, "armor"), span(4, 10, "credential")], 20);
    expect(merged[0].kind).toBe("armor+credential");
    // The same kind twice must not accumulate.
    expect(mergeOverlaps([span(0, 6, "armor"), span(4, 10, "armor")], 20)[0].kind).toBe("armor");
  });

  it("counts indices in UTF-16 code units, the same unit String.slice uses", () => {
    // Japanese text is one code unit per character; an astral character is two.
    // Byte offsets would be 3 and 4 respectively, so a collector that reported
    // bytes would cut in the wrong place -- and only on non-ASCII input, which
    // is exactly where it would go unnoticed.
    const text = "あいうえお𝄞かきくけこ";
    expect(text.length).toBe(12);
    // [2,5) is `うえお` -- half-open, so index 5 (the first half of the astral
    // character) is NOT included. The first draft of this expectation kept `お`
    // in the output, which is the off-by-one a half-open contract exists to make
    // visible.
    const merged = mergeOverlaps([span(2, 5, "jp")], text.length);
    expect(applySpansOnce(text, merged)).toBe(`あい${MASK}𝄞かきくけこ`);

    // And a span that cuts the astral character in half is representable but
    // produces a lone surrogate -- stages 3 and 4 must not emit such a span.
    expect(applySpansOnce(text, mergeOverlaps([span(5, 6, "jp")], text.length))).toContain(MASK);
  });

  it("rejects spans that violate the half-open contract", () => {
    expect(() => mergeOverlaps([span(4, 4)], 20)).toThrow(/non-empty and forward/);
    expect(() => mergeOverlaps([span(8, 4)], 20)).toThrow(/non-empty and forward/);
    expect(() => mergeOverlaps([span(0, 21)], 20)).toThrow(/out of range/);
    expect(() => mergeOverlaps([span(-1, 4)], 20)).toThrow(/out of range/);
    expect(() => mergeOverlaps([{ start: 0, end: 4, kind: "" }], 20)).toThrow(/needs a kind/);
    expect(() => mergeOverlaps([{ start: 0.5, end: 4, kind: "x" }], 20)).toThrow(/must be integers/);
  });
});

describe("applySpansOnce", () => {
  it("substitutes each merged span exactly once and never re-scans", () => {
    const text = "aaaaBBBBccccDDDD";
    const merged = mergeOverlaps([span(4, 8), span(12, 16)], text.length);
    expect(applySpansOnce(text, merged)).toBe(`aaaa${MASK}cccc${MASK}`);
  });

  it("leaves text untouched when nothing was collected", () => {
    const text = "nothing to redact here";
    expect(applySpansOnce(text, [])).toBe(text);
  });

  it("does not let a replacement become input to a later span", () => {
    // The mask token contains `*` and `MASKED`. Under the old sequential design a
    // later rule could match inside an earlier rule's output; here the offsets
    // are all resolved against the original, so the second span is unaffected by
    // the first substitution even though it sits immediately after it.
    const text = "xxxxyyyy";
    const merged = mergeOverlaps([span(0, 4), span(4, 8)], text.length);
    expect(applySpansOnce(text, merged)).toBe(MASK);
  });
});

/**
 * Builds the shortest string a lifted shape pattern accepts.
 *
 * This exists so the suite can exercise the provider shapes WITHOUT a literal
 * token shape anywhere in the file -- the samples are derived from the patterns
 * at run time. The repository's egress guard refuses writes containing such
 * literals, and it is right to: a spelled-out copy is also the thing that
 * drifts from its source.
 *
 * It handles only what the shipped patterns actually use -- literal runs,
 * character classes, `{n}` and `{n,}`. Anything else is a signal that the
 * vocabulary grew a construct this instrument cannot reach, and the assertion
 * below catches that rather than passing quietly.
 */
function shortestMatch(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    let unit: string;
    if (source[index] === "\\") {
      unit = source[index + 1] ?? "";
      index += 2;
    } else if (source[index] === "[") {
      const close = source.indexOf("]", index + 1);
      if (close < 0) throw new Error(`unterminated class in ${source}`);
      const body = source.slice(index + 1, close);
      // First member of the class: a range contributes its lower bound.
      unit = body[0] === "^" ? "A" : body[0];
      index = close + 1;
    } else {
      unit = source[index];
      index += 1;
    }
    // A quantifier applies to the unit just read.
    const quantifier = /^\{(\d+)(,?)\}/.exec(source.slice(index));
    if (quantifier) {
      out += unit.repeat(Number(quantifier[1]));
      index += quantifier[0].length;
    } else {
      out += unit;
    }
  }
  return out;
}

describe("credential vocabulary lifted from the shipped mask()", () => {
  it("lifts exactly the six shape rules, and says so by number", () => {
    // The count is the whole protection. Measured: breaking the lift so it finds
    // nothing, while leaving the fail-closed throw in place, turns ten tests red
    // -- but removing the throw as well leaves EVERY test green. So the throw was
    // pinned and the vocabulary was not: six wrong-but-compilable patterns would
    // have shipped without a single red assert.
    //
    // A new rule in the shell source is meant to break this line. That is a
    // deliberate, visible test edit, which is the opposite of a silent drop to
    // zero.
    const vocabulary = defaultVocabulary();
    expect(vocabulary.shapes).toHaveLength(6);
    expect(vocabulary.scheme).not.toBeNull();
    expect(vocabulary.anchor.source).not.toContain("(?!)");
  });

  it("masks a value of every lifted shape, using samples derived from the patterns", () => {
    const vocabulary = defaultVocabulary();
    for (const shape of vocabulary.shapes) {
      const sample = shortestMatch(shape.source);
      // The instrument is checked before it is trusted. A generator that emits
      // something the pattern rejects would otherwise make this test vacuous in
      // the safe direction -- it would go red, but for the wrong reason, and the
      // message would blame the redactor.
      expect(new RegExp(`^(?:${shape.source})$`).test(sample)).toBe(true);

      const out = redactText(`value ${sample} end`);
      expect(out.status).toBe("ok");
      expect(out.text).not.toContain(sample);
      expect(out.text).toContain(MASK);
      // The surrounding words survive: this is a shape rule, not a line rule.
      expect(out.text).toContain("end");
    }
  });

  it("returns patterns that are verbatim substrings of the shipped source", () => {
    // Closes the gap the positive control below leaves open. Replacing all six
    // sources with one wrong-but-compilable pattern reddens that control only
    // because it names the substitute; a different substitute would satisfy both
    // it and the coverage test, since each derives its sample from the same
    // wrong source. Nothing in a self-consistent vocabulary is checkable from
    // inside the vocabulary.
    //
    // What is checkable is provenance: a lifted pattern has to occur in the file
    // it was lifted from. That is what makes these the SHIPPED rules rather than
    // six strings this module happens to carry.
    const vocabulary = defaultVocabulary();
    const shellSource = readFileSync(SHIPPED_MASK, "utf8");
    for (const shape of vocabulary.shapes) {
      expect(shellSource).toContain(shape.source);
    }
    const distinct = new Set(vocabulary.shapes.map((shape) => shape.source));
    expect(distinct.size).toBe(vocabulary.shapes.length);
  });

  it("does not mask a shape the vocabulary does not carry", () => {
    // Positive control for the test above. Without it, a collector that masked
    // everything would pass every assertion there, and the suite would be
    // measuring nothing but its own eagerness.
    const vocabulary = defaultVocabulary();
    const notAShape = { kind: "credential:shape", source: "ZZQQ[0-9]{12}" };
    expect(vocabulary.shapes.map((shape) => shape.source)).not.toContain(notAShape.source);

    const sample = shortestMatch(notAShape.source);
    const out = redactText(`value ${sample} end`);
    expect(out.status).toBe("ok");
    expect(out.text).toContain(sample);
  });
});

describe("findings from the pre-commit review", () => {
  const CANARY = "C4N4RY" + "_x9";
  const DASHES = "-".repeat(5);
  const BODY = "SYNTHETICBODYQWERTY0123456789";

  it("masks the credential after an auth scheme the shell gave its own rule", () => {
    // The shipped sed masks this header; this module did not. The scheme word is
    // absent from the lifted allowlist because the shell handles it separately,
    // so the keyword anchored first, took the scheme word as its bare value, and
    // moved past the credential -- emitting a mask token immediately to the LEFT
    // of the secret, which is the shape that reads as a successful redaction.
    for (const input of [`curl -H "Authorization: Bearer ${CANARY}" https://x/`, `Authorization: Bearer ${CANARY}`]) {
      const out = redactText(input);
      expect(out.status).toBe("ok");
      expect(out.text).not.toContain(CANARY);
      // The scheme word itself is structure, not secret: it stays.
      expect(out.text).toContain("Bearer");
    }
    // Controls that were already green, kept so a regression here is separable
    // from one in the allowlist path.
    expect(redactText(`Authorization: Basic ${CANARY}`).text).not.toContain(CANARY);
    expect(redactText(`Bearer ${CANARY}`).text).not.toContain(CANARY);
  });

  it("clips a protected label out of a span instead of dropping the whole span", () => {
    // Dropping it meant anything glued to an armor delimiter survived. Every
    // case below was masked by the shipped sed and emitted in the clear here.
    const cases = [
      `token=${CANARY}${DASHES}BEGIN PRIVATE KEY${DASHES}\n${BODY}\n${DASHES}END PRIVATE KEY${DASHES}`,
      `token=${CANARY}${DASHES}BEGIN X${DASHES}`,
      `${DASHES}BEGIN KEY ${DASHES}${CANARY}`,
      `password="${CANARY} ${DASHES}BEGIN X${DASHES}"`
    ];
    for (const input of cases) {
      const out = redactText(input);
      expect(out.status).toBe("ok");
      expect(out.text).not.toContain(CANARY);
    }
    // And the public label still survives -- the point of the guard. Asserting
    // only the absence of the canary would pass on a build that masked the label
    // too, which is the defect the guard was added for.
    expect(redactText(`token=${CANARY}${DASHES}BEGIN X${DASHES}`).text).toContain("BEGIN X");
  });

  it("refuses a vocabulary that lifted only part of itself", () => {
    // Each part is checked separately. Measured: a shape count of six survives
    // every one of these, so the total proves nothing on its own.
    const source = readFileSync(SHIPPED_MASK, "utf8");
    const partial: [string, string][] = [
      ["vocabulary_no_keywords", source.replace(/\(\(token\|/g, "(<(token|")],
      ["vocabulary_scheme_lift_narrowed", source.replace(/\[:space:\]\]\+\(Basic/g, "[:space:]]+X(Basic")],
      ["vocabulary_empty", source.replace(/-e 's\//g, "-e 'S/")]
    ];
    for (const [reason, mutated] of partial) {
      let thrown: unknown;
      try {
        assertUsableVocabulary(vocabularyFrom(mutated));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RedactionOmitted);
      expect((thrown as RedactionOmitted).reason).toBe(reason);
    }
    // Negative control: the real source passes. Without it, a validator that
    // threw unconditionally would satisfy every assertion above.
    expect(() => assertUsableVocabulary(vocabularyFrom(source))).not.toThrow();
  });

  it("counts the auth-scheme words rather than checking the regex is non-null", () => {
    // A non-null scheme says only that ONE word was found. With the spelled-out
    // rule contributing one by itself, the null check became unreachable and an
    // allowlist that lifted nothing passed -- measured while trying to redden it.
    const vocabulary = defaultVocabulary();
    expect(vocabulary.schemeWords).toHaveLength(EXPECTED_SCHEME_WORDS);
    const shellSource = readFileSync(SHIPPED_MASK, "utf8");
    // Provenance, as with the shapes -- but scoped to the ALTERNATION, not to the
    // file. Asking whether a word appears anywhere in the source returned seven
    // of seven, because the shell's comments name the scheme that has its own
    // rule; the assertion passed for the wrong reason and would have kept passing
    // if the allowlist lift broke and the word were only ever a comment.
    const alternation = /\[:space:\]\]\+\(([A-Za-z|]+)\)\[\[:space:\]\]/.exec(shellSource)?.[1] ?? "";
    const listed = alternation.split("|").filter(Boolean);
    expect(listed).toHaveLength(EXPECTED_SCHEME_WORDS - 1);
    for (const word of listed) expect(vocabulary.schemeWords).toContain(word);
    // The seventh comes from a rule spelled one character class per letter, so it
    // is checked by that spelling and must NOT be in the alternation.
    const spelled = vocabulary.schemeWords.filter((word) => !listed.includes(word));
    expect(spelled).toEqual(["Bearer"]);
    expect(shellSource).toMatch(/\[Bb\]\[Ee\]\[Aa\]\[Rr\]\[Ee\]\[Rr\]/);
  });

  it("treats a fat-comma arrow as part of the separator, not the value", () => {
    // The separator stopped at the arrow, the bare walk masked the arrow, and the
    // credential survived one token to the right of a mask -- the same shape that
    // made the auth-scheme leak look like a successful redaction. The shipped sed
    // does this too, so it is not a regression; it is left fixed here because the
    // deceptive shape is the part worth removing.
    const out = redactText(`'password' => '${CANARY}'`);
    expect(out.status).toBe("ok");
    expect(out.text).not.toContain(CANARY);

    // A known limit, pinned so it is a recorded gap rather than a silent one: a
    // subscripted key never anchors, because the keyword is followed by a bracket
    // rather than a separator. The shipped sed does not mask it either, and
    // widening the anchor to reach it is a separate decision about over-capture.
    expect(redactText(`$c['password'] = '${CANARY}'`).text).toContain(CANARY);
  });

  it("treats a doubled quote as an escape, closing #186 in both spellings", () => {
    const TAIL = "TA1L" + "_x9";
    // The issue names the single-quote spelling; the same hole existed for the
    // doubled double-quote, which it does not mention.
    for (const quote of ["'", '"']) {
      const input = `password: ${quote}${CANARY}${quote}${quote}${TAIL}${quote}`;
      const out = redactText(input);
      expect(out.status).toBe("ok");
      expect(out.text).not.toContain(CANARY);
      expect(out.text).not.toContain(TAIL);
    }

    // Regressions this could have caused, measured and pinned. An empty value
    // closes correctly because the character after the pair is not a quote, so
    // it is neither masked nor read as unterminated.
    expect(redactText(`password: "" next`).text).toContain("next");
    // An adjacent field keeps its own value.
    const json = redactText(`{"password":"${CANARY}","user":"bob"}`);
    expect(json.text).not.toContain(CANARY);
    expect(json.text).toContain("bob");
    // A backslash escape still works.
    expect(redactText(`password: '${CANARY}\\'${TAIL}'`).text).not.toContain(CANARY);

    // A recorded limit rather than a silent one: quotes doubled at the BOUNDARY
    // are ambiguous -- an empty value followed by a bare token reads identically
    // -- so no walk settles it, and the shipped sed does not either.
    expect(redactText(`password: ""${CANARY}"" ${TAIL}`).text).toContain(CANARY);
  });

  it("keeps the line count when a quoted value ends in a backslash", () => {
    // The escape skip ran before the line check, so a backslash at end of line
    // consumed the newline and the walk continued onto the next line, joining
    // two of them. The armor path is careful about this; the credential path was
    // not, and a line-count change is how a fence stops lining up.
    const input = `token="ab\\\ncd" tail\nline3`;
    const out = redactText(input);
    expect(out.status).toBe("ok");
    expect(out.text.split("\n")).toHaveLength(input.split("\n").length);
  });

  it("does not omit the fragment for a benign unterminated quote", () => {
    // Omitting cost 7% of this worktree's tracked text files, and handed anyone
    // who can place text in a tool result a way to blank the record. The shell
    // falls through to its bare rule here, and so does this now: the value is
    // masked to the next space and the fragment survives.
    const input = `grep -n "token: " src/*.ts`;
    const out = redactText(input);
    expect(out.status).toBe("ok");
    expect(out.text).toContain("src/*.ts");
    expect(out.text).toContain("grep -n");
  });

  it("stays linear when an input carries many labels and many anchors", () => {
    // `guards.some(...)` per span measured 4.6 s at 1 MiB, 12.2 s at 2 MiB and
    // 48.3 s at 4 MiB -- about 190 s extrapolated to the fragment ceiling, per
    // fragment, with no hook timeout above it. The bound is what is asserted,
    // not the constant: a wall-clock number would be a flaky test on shared CI.
    const unit = `${DASHES}BEGIN A${DASHES} key x `;
    const build = (kib: number) => unit.repeat(Math.ceil((kib * 1024) / unit.length));
    const time = (text: string) => {
      const started = performance.now();
      expect(redactText(text).status).toBe("ok");
      return performance.now() - started;
    };
    const small = time(build(256));
    const large = time(build(1024));
    // Four times the input, well under sixteen times the work. The previous
    // shape was measured at roughly four times per doubling.
    expect(large).toBeLessThan(Math.max(small * 12, 2000));
  });
});

describe("collector order independence", () => {
  it("gives the same result whichever collector's spans come first", () => {
    // The property that replaces the ordering pins. Stages 3 and 4 will make the
    // collectors non-trivial; the invariant is asserted here first so their
    // implementations are written against it rather than measured after.
    const text = "some text with two interesting runs inside it";
    const armor = [span(5, 9, "armor")];
    const credential = [span(20, 31, "credential")];
    const a = applySpansOnce(text, mergeOverlaps([...armor, ...credential], text.length));
    const b = applySpansOnce(text, mergeOverlaps([...credential, ...armor], text.length));
    expect(a).toBe(b);
  });

  it("gives the same result when the two collectors claim overlapping runs", () => {
    const text = "some text with two interesting runs inside it";
    const armor = [span(5, 24, "armor")];
    const credential = [span(20, 31, "credential")];
    const a = mergeOverlaps([...armor, ...credential], text.length);
    const b = mergeOverlaps([...credential, ...armor], text.length);
    expect(applySpansOnce(text, a)).toBe(applySpansOnce(text, b));
    expect(a.map((s) => [s.start, s.end])).toEqual(b.map((s) => [s.start, s.end]));
  });

  it("reads the same original for both collectors, so neither can consume the other's anchor", () => {
    // The input both collectors want a piece of, and the one the sed pipeline
    // could not settle: the armor rule needs the BEGIN marker, and the keyword
    // rule wants the value that starts at that same marker. Whichever ran first
    // consumed what the other needed -- moving the PEM rules ahead closed the
    // marker case and opened the anchor case, measured both ways.
    //
    // Asserting an unchanged string here (what the stage-2 stub version did)
    // stopped meaning anything the moment the collectors were implemented. What
    // is asserted instead is that BOTH still fire on the same original.
    const dashes = "-".repeat(5);
    const label = "PRIVATE KEY";
    const body = "SYNTHETICBODYQWERTY0123456789";
    const text = `token=${dashes}BEGIN ${label}${dashes}\n${body}\n${dashes}END ${label}${dashes}`;

    // The armor block was recognised: the marker was not eaten by the keyword.
    expect(collectArmorSpans(text).length).toBeGreaterThan(0);
    // The keyword was seen: the anchor was not eaten by the armor rule.
    const vocabulary = defaultVocabulary();
    expect(collectCredentialSpans(text, { vocabulary }).length).toBeGreaterThan(0);

    const out = redactText(text);
    expect(out.status).toBe("ok");
    expect(out.text).not.toContain(body);

    // Concatenating the two collectors' spans either way round must land on the
    // same bytes. This is the property that replaces the ordering pins: there is
    // no order left to constrain, so it cannot go vacuous the way they did.
    const armor = collectArmorSpans(text);
    const credential = withoutProtected(collectCredentialSpans(text, { vocabulary }), collectProtectedSpans(text));
    const forward = applySpansOnce(text, mergeOverlaps([...armor, ...credential], text.length));
    const reverse = applySpansOnce(text, mergeOverlaps([...credential, ...armor], text.length));
    expect(forward).toBe(reverse);
    expect(forward).not.toContain(body);
  });
});

describe("redactText contract", () => {
  it("omits the body rather than scanning an over-size fragment", () => {
    const result = redactText("a".repeat(64), { maxBytes: 32 });
    expect(result.status).toBe("omitted");
    expect(result.reason).toBe("fragment_over_limit");
    expect(result.text).toBe(omitted("fragment_over_limit"));
    // The omission token must be distinguishable from an ordinary mask.
    expect(result.text).not.toBe(MASK);
  });

  it("measures the limit in bytes, not characters", () => {
    // Three bytes per character here, so 12 characters is 36 bytes.
    const jp = "あ".repeat(12);
    expect(jp.length).toBe(12);
    expect(redactText(jp, { maxBytes: 32 }).status).toBe("omitted");
    expect(redactText(jp, { maxBytes: 64 }).status).toBe("ok");
  });

  it("omits rather than returning the original when a collector breaks its contract", () => {
    // Failing open is the one outcome worse than losing the body, so there is no
    // path back to the raw input.
    const text = "sensitive";
    const broken = () => [{ start: 0, end: 99, kind: "bad" }];
    const spans = broken();
    expect(() => mergeOverlaps(spans, text.length)).toThrow(/out of range/);
  });

  it("rejects a non-string fragment instead of coercing it", () => {
    // @ts-expect-error deliberately wrong type
    const result = redactText(undefined);
    expect(result.status).toBe("omitted");
    expect(result.reason).toBe("non_string_input");
  });

  it("resets state between fragments in a batch", () => {
    const results = redactFragments(["first", "second", "third"]);
    expect(results.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(results.map((r) => r.text)).toEqual(["first", "second", "third"]);
  });

  it("does not run its CLI when imported", () => {
    // `redact-log.mjs` has a stdin-reading main(). Importing it above must not
    // have consumed stdin or written anything; reaching this assertion is the
    // evidence.
    expect(typeof redactText).toBe("function");
  });
});
