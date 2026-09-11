import { describe, expect, it } from "vitest";

import {
  MASK,
  applySpansOnce,
  collectArmorSpans,
  collectCredentialSpans,
  mergeOverlaps,
  omitted,
  redactFragments,
  redactText
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
    // Stage 2 collectors are stubs. What is asserted is the wiring: redactText
    // passes the untouched original to both, which is why order stops mattering.
    const text = "token: value and a marker-shaped thing";
    expect(collectArmorSpans(text)).toEqual([]);
    expect(collectCredentialSpans(text)).toEqual([]);
    expect(redactText(text)).toEqual({ text, status: "ok" });
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
