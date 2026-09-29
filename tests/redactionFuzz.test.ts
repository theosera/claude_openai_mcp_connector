import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compare, type FuzzCase, generate, SED_COPIES, sedEngine, shippedMask } from "./tools/redactionFuzz.js";
import { broken, type Engine, type EngineResult, readable } from "./tools/redactionJudge.js";

/**
 * The differential fuzz, on the committed sample (seed 1, 170 cases = 10 of each
 * family). The full runs (several seeds x 16,000 cases) are the tool's job; this
 * pins the generator and shows the runner can see what it claims to compare.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(HERE, "fixtures", "redaction-fuzz", "seed-1.jsonl");

const sample: FuzzCase[] = readFileSync(SAMPLE, "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as FuzzCase);

/** Runs the sed engine once per distinct input: each run is a bash process per case. */
function memo(engine: Engine): Engine {
  const seen = new Map<string, EngineResult>();
  return (fragments) => {
    const fresh = [...new Map(fragments.filter((f) => !seen.has(f.text)).map((f) => [f.text, f])).values()];
    if (fresh.length > 0) engine(fresh).forEach((r, k) => seen.set(fresh[k]!.text, r));
    return fragments.map((f) => seen.get(f.text)!);
  };
}

const capture = memo(sedEngine(shippedMask(SED_COPIES.capture)));
const archive = memo(sedEngine(shippedMask(SED_COPIES.archive)));
const identity: Engine = (fragments) => fragments.map(({ text }) => ({ text, status: "ok" }));

describe("the fuzz generator", () => {
  it("regenerates the committed sample byte for byte", () => {
    const text = generate(1, 170)
      .map((c) => JSON.stringify(c))
      .join("\n");
    expect(`${text}\n`).toBe(readFileSync(SAMPLE, "utf8"));
  });

  it("gives other seeds other cases", () => {
    expect(generate(2, 17).map((c) => c.input)).not.toEqual(generate(1, 17).map((c) => c.input));
  });
});

describe("the shared judge on a real over-mask of the shipped sed mask()", { timeout: 60_000 }, () => {
  // B-N1: the sed mask() swallows the first `gpg` into the mask token and keeps
  // the second, so asking "is gpg still there" says yes. Counting says one is gone.
  it("charges the sed mask() with the gpg it swallows in corpus case B-N1", () => {
    const corpus = readFileSync(join(HERE, "fixtures", "redaction-corpus", "corpus.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FuzzCase);
    const bn1 = corpus.find((c) => c.id === "B-N1")!;
    const out = capture([{ text: bn1.input, kind: bn1.kind }])[0]!.text;
    expect(out.includes("gpg")).toBe(true);
    expect(broken(bn1.input, out, bn1.preserve)).toEqual(["gpg"]);
  });
});

// Each sed run is a bash process per case; under a full parallel suite that can pass 5 s.
describe("the fuzz runner against the shipped sed mask()", { timeout: 60_000 }, () => {
  const bySed = capture(sample.map((c) => ({ text: c.input, kind: c.kind })));

  // Negative control: the reference compared with itself has nothing new.
  it("finds nothing new when the candidate is the sed mask() itself", () => {
    const col = compare(sample, capture, archive, capture);
    expect([col.new_leaked, col.new_broken, col.fixed, col.omitted, col.copy_mismatch]).toEqual([[], [], [], [], []]);
  });

  // Positive control: an engine that masks nothing is charged with every case in
  // which the sed mask() hid a secret.
  it("charges an engine that masks nothing with every case the sed mask() hid a secret in", () => {
    const hidden = sample.filter((c, i) => readable(bySed[i]!.text, c.secrets).length < c.secrets.length);
    expect(hidden.length).toBeGreaterThan(0);
    expect(compare(sample, capture, archive, identity).new_leaked).toEqual(hidden.map((c) => c.id));
  });

  it("charges an engine that returns nothing with the preserve words the sed mask() kept, and no leak", () => {
    const col = compare(sample, capture, archive, (fragments) => fragments.map(() => ({ text: "", status: "ok" })));
    const kept = sample.filter((c, i) => c.preserve.some((p) => bySed[i]!.text.includes(p)));
    expect(kept.length).toBeGreaterThan(0);
    expect(col.new_broken).toEqual(kept.map((c) => c.id));
    expect(col.new_leaked).toEqual([]);
  });

  // The candidate must receive each case's own kind: an engine that reads it
  // (#249 step ②-3) judges `''` in a YAML text and in a shell command differently.
  it("hands the candidate every case with its own kind", () => {
    const seen: string[] = [];
    compare(sample, capture, archive, (fragments) => {
      seen.push(...fragments.map((f) => f.kind));
      return fragments.map(({ text }) => ({ text, status: "ok" }));
    });
    expect(seen).toEqual(sample.map((c) => c.kind));
    expect(new Set(seen).size).toBe(2);
  });

  it("finds the two shipped copies of mask() in agreement on every case", () => {
    expect(compare(sample, capture, archive, capture).copy_mismatch).toEqual([]);
  });

  // The copy check must see a drift between the two hooks, not only report none.
  // The bare passwd / passphrase rule is taken out of a scratch copy of the capture
  // hook; the mutation is asserted to have landed before its effect is read.
  it("reports a copy mismatch when one hook's mask() loses a rule", () => {
    const hook = readFileSync(join(HERE, "..", SED_COPIES.capture), "utf8");
    const lines = hook.split("\n");
    const target = lines.filter((line) => line.includes("(passwd|passphrase)[=:[:space:]]+)"));
    expect(target).toHaveLength(1);
    const mutated = lines.filter((line) => line !== target[0]).join("\n");
    expect(mutated.split("\n")).toHaveLength(lines.length - 1);

    const root = mkdtempSync(join(tmpdir(), "fuzz-copy-"));
    mkdirSync(join(root, dirname(SED_COPIES.capture)), { recursive: true });
    writeFileSync(join(root, SED_COPIES.capture), mutated);
    const drifted = sedEngine(shippedMask(SED_COPIES.capture, root));

    const probe = sample.filter((c) => c.family === "passwd-label");
    expect(probe.length).toBeGreaterThan(0);
    expect(compare(probe, drifted, archive, archive).copy_mismatch).toEqual(probe.map((c) => c.id));
    expect(compare(probe, capture, archive, archive).copy_mismatch).toEqual([]);
  });
});
