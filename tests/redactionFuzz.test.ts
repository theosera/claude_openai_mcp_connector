import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

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

/**
 * Runs the sed engine once per distinct input: each run is a bash process per case.
 * It keys on the text alone, so it is for the sed engines only: an engine that reads
 * the kind can answer the same text differently in a command and in a text.
 */
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
    // The runner reports it as the sed mask()'s own over-mask, which no red column carries.
    const col = compare([bn1], capture, archive, capture);
    expect(col.main_broken).toEqual(["B-N1"]);
    expect(col.new_broken).toEqual([]);
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

// Exit 1 is a red result and exit 2 a broken run: a run that crashed must never be
// read as one that found gaps.
describe("the fuzz runner's exit status", { timeout: 120_000 }, () => {
  const ROOT = join(HERE, "..");
  const run = (engine: string) =>
    spawnSync(
      "pnpm",
      ["exec", "tsx", "tests/tools/redactionFuzz.ts", "--seed", "1", "--count", "17", "--engine", engine],
      { cwd: ROOT, encoding: "utf8" }
    );

  it("exits 1 when an engine that masks nothing leaves red columns", () => {
    const r = run("node tests/tools/echoEngine.mjs");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('"new_leaked"');
  });

  it("exits 2 when the engine cannot run at all", () => {
    const r = run("node tests/tools/no-such-engine.mjs");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
  });
});

// A run that judged nothing must not exit 0. Each case goes through the same
// `pnpm exec tsx` the full runs use; the engine leaves a sentinel file when it
// starts, so "the argument was refused before any engine ran" is observed, not
// inferred from an engine that could not have run anyway.
describe("the fuzz runner's command line", { timeout: 300_000 }, () => {
  const ROOT = join(HERE, "..");
  const SCRIPT = join(ROOT, "tests", "tools", "redactionFuzz.ts");
  const ECHO = "node tests/tools/echoEngine.mjs";
  const dir = mkdtempSync(join(tmpdir(), "fuzz-cli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // The runner splits --engine on spaces.
  const SENTINEL_ENGINE = `node ${join(dir, "engine.mjs")}`;
  writeFileSync(
    join(dir, "engine.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'import process from "node:process";',
      'writeFileSync(process.env.FUZZ_ENGINE_STARTED, "");',
      `await import(${JSON.stringify(pathToFileURL(join(ROOT, "tests", "tools", "echoEngine.mjs")).href)});`,
      ""
    ].join("\n")
  );

  type Run = { status: number | null; signal: string | null; stdout: string; stderr: string; started: boolean };
  let runs = 0;
  const run = (script: string, args: string[]): Promise<Run> => {
    const started = join(dir, `started-${runs++}`);
    return new Promise((resolve, reject) => {
      const child = spawn("pnpm", ["exec", "tsx", script, ...args], {
        cwd: ROOT,
        env: { ...process.env, FUZZ_ENGINE_STARTED: started }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr, started: existsSync(started) }));
    });
  };
  type Report = { reference: string; seed: number; cases: number; new_leaked: number };
  const reports = (r: Run) =>
    r.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Report);

  it("rejects invalid numeric arguments before running the engine", async () => {
    expect(dir).not.toContain(" ");
    const E = SENTINEL_ENGINE;
    // Each row names the check that must refuse it, so taking one check out shows
    // on its own rows even where the other check would still refuse the value:
    // "range" for a value Number() reads outside the range, "digits" for one it
    // reads inside the range but spelled otherwise, "value" for a missing value.
    type Why = "range" | "digits" | "value";
    type Bad = [option: string, why: Why, args: string[]];
    const count = (v: string, why: Why): Bad => ["count", why, ["--seed", "1", "--count", v, "--engine", E]];
    const seed = (v: string, why: Why): Bad => ["seed", why, ["--seed", v, "--count", "17", "--engine", E]];
    const bad: Bad[] = [
      ...["typo", "NaN", "Infinity", "-Infinity", "0", "-1", "9007199254740992", "", " "].map((v) => count(v, "range")),
      ...["1.5", "1e3", "0x10", "+17", " 17"].map((v) => count(v, "digits")),
      ...["typo", "NaN", "Infinity", "-1", "4294967296"].map((v) => seed(v, "range")),
      ...["1.5", "", " ", "-0"].map((v) => seed(v, "digits")),
      ["count", "value", ["--seed", "1", "--engine", E, "--count"]],
      ["seed", "value", ["--count", "17", "--engine", E, "--seed"]],
      ["count", "value", ["--seed", "1", "--count", "--engine", E]],
      ["seed", "value", ["--seed", "--count", "17", "--engine", E]],
      ["engine", "value", ["--seed", "1", "--count", "17", "--engine"]],
      ["engine", "value", ["--seed", "1", "--count", "17", "--engine", "--count"]]
    ];
    const results: Run[] = [];
    for (let i = 0; i < bad.length; i += 6) {
      results.push(...(await Promise.all(bad.slice(i, i + 6).map(([, , args]) => run(SCRIPT, args)))));
    }
    const refusal = (option: string, stderr: string) => {
      const line = stderr.split("\n")[0]!;
      if (!line.startsWith(`Error: --${option} `)) return line;
      if (line.includes(" must be between ")) return "range";
      if (line.includes(" must be written in decimal digits")) return "digits";
      if (line.endsWith(" needs a value")) return "value";
      return line;
    };
    const seen = results.map((r, i) => ({
      args: bad[i]![2].join(" "),
      status: r.status,
      signal: r.signal,
      stdout: r.stdout,
      refused: refusal(bad[i]![0], r.stderr),
      started: r.started
    }));
    expect(seen).toEqual(
      bad.map(([, why, args]) => ({
        args: args.join(" "),
        status: 2,
        signal: null,
        stdout: "",
        refused: why,
        started: false
      }))
    );
  });

  // The positive control for the sentinel: a valid run does start the engine.
  it("accepts boundary seeds and reports the requested case count", async () => {
    for (const seed of ["0", "4294967295"]) {
      const r = await run(SCRIPT, ["--seed", seed, "--count", "17", "--engine", SENTINEL_ENGINE]);
      expect(r.status, r.stderr).toBe(1);
      expect(r.started).toBe(true);
      const rows = reports(r);
      expect(rows.map((x) => [x.reference, x.seed, x.cases])).toEqual([
        ["capture", Number(seed), 17],
        ["archive", Number(seed), 17]
      ]);
      expect(rows.every((x) => x.new_leaked > 0)).toBe(true);
    }
  });

  it("runs the fuzz through a symlinked entrypoint", async () => {
    const link = join(dir, "redactionFuzz.ts");
    symlinkSync(SCRIPT, link);
    const args = ["--seed", "1", "--count", "17", "--engine", ECHO];
    const [direct, linked] = await Promise.all([run(SCRIPT, args), run(link, args)]);
    expect(direct.status, direct.stderr).toBe(1);
    expect(reports(direct).map((x) => [x.reference, x.cases])).toEqual([
      ["capture", 17],
      ["archive", 17]
    ]);
    expect({ status: linked.status, stdout: linked.stdout }).toEqual({ status: 1, stdout: direct.stdout });
  });

  it("does not run the fuzz when imported", async () => {
    const importer = join(dir, "importer.mjs");
    writeFileSync(importer, `import ${JSON.stringify(pathToFileURL(SCRIPT).href)};\n`);
    // The importer is given the runner's own arguments, so a main() that ran on
    // import would judge 17 cases and start the engine.
    const r = await run(importer, ["--seed", "1", "--count", "17", "--engine", SENTINEL_ENGINE]);
    expect(r).toEqual({ status: 0, signal: null, stdout: "", stderr: "", started: false });
  });
});
