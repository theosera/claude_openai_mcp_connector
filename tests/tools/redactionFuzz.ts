/**
 * The differential fuzz for the log redactor (#249): generated cases, and a runner
 * that judges an engine against the sed `mask()` on every one of them.
 *
 *   pnpm exec tsx tests/tools/redactionFuzz.ts --seed 13 --count 16000 \
 *     --engine "node packages/log-redaction/src/cli.mjs"
 *
 * Every case carries marker words: a secret is `FK` + 8 characters with at least
 * one digit, a preserve word is `KEEP` + 6. No marker is part of another or of the
 * mask token, and every marker is in the input; the generator refuses a case that
 * breaks either rule instead of dropping it.
 *
 * The runner compares the candidate with BOTH shipped copies of `mask()` (the
 * capture hook and the archive hook) and sorts each case into columns:
 *
 *   new_leaked    the sed mask() hid a secret and the candidate does not   (red)
 *   new_broken    the sed mask() kept a preserve word and the candidate does not (red)
 *   main_leaked   both leave a secret readable: the sed mask()'s own leak, reported,
 *                 not allowed
 *   main_broken   the sed mask() itself removed a preserve word: its own over-mask,
 *                 reported for reference
 *   fixed         the sed mask() leaves a secret readable and the candidate hides it
 *   omitted       the candidate dropped the body
 *   copy_mismatch the two sed copies disagree on the case                     (red)
 *
 * The run exits 1 when any red column is non-empty for either reference, and 2
 * when the run itself fails or an argument is invalid, so a broken run is never
 * read as a red result and a run that judged nothing is never read as a pass.
 * `--seed` (0 to 4294967295) and `--count` (at least 1, default 16000) take
 * decimal digits only.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { commandEngine, type Engine, judgeCase, MASK, readable } from "./redactionJudge.js";

export type FuzzCase = {
  id: string;
  family: string;
  seed: number;
  kind: "command" | "text";
  input: string;
  secrets: string[];
  preserve: string[];
};

/** mulberry32: small, deterministic, and the same in every runtime. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = "ABCDEFGHJKLNPQRTUVWXYZ0123456789";

type Parts = { S: () => string; K: () => string; pick: <T>(xs: readonly T[]) => T; r: () => number };

type Family = { name: string; kind: "command" | "text"; make: (p: Parts) => string };

const Q = ['"', "'"] as const;
const LABELS = ["password", "token", "secret", "api_key", "pat"] as const;

/**
 * The shapes #249 names: both quote directions, a label whose closing quote comes
 * first, dash runs of 4 to 8, an unclosed quote from prose, the shell's `'\''` and
 * YAML's `''`, argument-position secrets, adjacent keywords, and a preserve word on
 * the next line. Preserve words sit at the edges of the secret's range, where an
 * over-reaching rule eats them first.
 */
const FAMILIES: readonly Family[] = [
  { name: "mysql-p", kind: "command", make: (p) => `mysql -u app -p${p.S()} ${p.K()}` },
  {
    name: "mysql-p-quoted",
    kind: "command",
    make: (p) => {
      const q = p.pick(Q);
      return `mysql -h db -p${q}${p.S()}${q} ${p.K()}`;
    }
  },
  { name: "redis-a", kind: "command", make: (p) => `redis-cli -h cache -a ${p.S()} ${p.K()}` },
  { name: "curl-u", kind: "command", make: (p) => `curl -u deploy:${p.S()} https://example.test/${p.K()}` },
  {
    name: "label-quoted",
    kind: "text",
    make: (p) => {
      const q = p.pick(Q);
      return `${p.pick(LABELS)}: ${q}${p.S()}${q} ${p.K()}`;
    }
  },
  { name: "json-pair", kind: "text", make: (p) => `{"${p.pick(LABELS)}": "${p.S()}", "${p.K()}": 1}` },
  { name: "label-bare", kind: "command", make: (p) => `export ${p.pick(LABELS).toUpperCase()}=${p.S()} ${p.K()}` },
  { name: "adjacent-keywords", kind: "command", make: (p) => `password=${p.S()} token=${p.S()} ${p.K()}` },
  {
    name: "dash-run",
    kind: "command",
    make: (p) => `--password ${p.S()}${"-".repeat(4 + Math.floor(p.r() * 5))}${p.S()} ${p.K()}`
  },
  {
    name: "passphrase-quoted",
    kind: "command",
    make: (p) => {
      const q = p.pick(Q);
      return `gpg --passphrase ${q}${p.S()} ${p.S()}${q} ${p.K()}`;
    }
  },
  { name: "passwd-label", kind: "text", make: (p) => `passwd: ${p.S()}\n${p.K()} next line` },
  { name: "yaml-doubled", kind: "text", make: (p) => `password: '${p.S()}''${p.S()} with X'\n${p.K()}: 1` },
  { name: "shell-quote-join", kind: "command", make: (p) => `echo 'token='\\''${p.S()}'\\'' ${p.K()}` },
  {
    name: "label-closes-first",
    kind: "command",
    make: (p) => {
      const q = p.pick(Q);
      return `grep -n ${q}token: ${q} src/${p.K()}.ts && echo token=${p.S()} ${p.K()}`;
    }
  },
  {
    name: "prose-apostrophe",
    kind: "text",
    make: (p) => `the mysql client won't prompt if you pass -p${p.S()} ${p.K()}`
  },
  { name: "next-line", kind: "text", make: (p) => `token=${p.S()}\n${p.K()} stays` },
  { name: "preserve-only", kind: "command", make: (p) => `grep -rn "password" docs/${p.K()} | head -n 3` }
];

function word(r: () => number, prefix: string, length: number): string {
  for (;;) {
    let w = prefix;
    for (let i = 0; i < length; i++) w += ALNUM[Math.floor(r() * ALNUM.length)];
    if (/[0-9]/.test(w.slice(prefix.length))) return w;
  }
}

/** Refuses a case whose markers can be misjudged: see the header. */
function assertMarkers(c: FuzzCase): void {
  const words = [...c.secrets, ...c.preserve];
  for (const w of words) {
    if (!c.input.includes(w)) throw new Error(`${c.id}: ${w} is not in the input`);
    if (MASK.includes(w)) throw new Error(`${c.id}: ${w} is part of the mask token`);
    for (const v of words) if (v !== w && v.includes(w)) throw new Error(`${c.id}: ${w} is part of ${v}`);
  }
  if (new Set(words).size !== words.length) throw new Error(`${c.id}: a marker repeats`);
}

export function generate(seed: number, count: number): FuzzCase[] {
  const r = rng(seed);
  const cases: FuzzCase[] = [];
  for (let n = 0; n < count; n++) {
    const secrets: string[] = [];
    const preserve: string[] = [];
    const parts: Parts = {
      S: () => {
        const w = word(r, "FK", 8);
        secrets.push(w);
        return w;
      },
      K: () => {
        const w = word(r, "KEEP", 6);
        preserve.push(w);
        return w;
      },
      pick: (xs) => xs[Math.floor(r() * xs.length)]!,
      r
    };
    const family = FAMILIES[n % FAMILIES.length]!;
    const prefix = parts.pick(["", "", "$ ", "> ", "  "]);
    const input = prefix + family.make(parts);
    const c: FuzzCase = {
      id: `FZ-s${seed}-${String(n).padStart(6, "0")}`,
      family: family.name,
      seed,
      kind: family.kind,
      input,
      secrets,
      preserve
    };
    assertMarkers(c);
    cases.push(c);
  }
  return cases;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");

export const SED_COPIES = {
  capture: join(".claude", "skills", "ops-logging", "capture-command.sh"),
  archive: join(".claude", "skills", "session-archive", "archive-session.sh")
} as const;

/** The mask() function as it ships in one hook, extracted by its anchors. */
export function shippedMask(relPath: string, root: string = ROOT): string {
  const lines = readFileSync(join(root, relPath), "utf8").split("\n");
  const start = lines.indexOf("mask() {");
  const end = lines.findIndex((line, index) => index > start && line === "}");
  if (start === -1 || end === -1) throw new Error(`mask() not found in ${relPath}: the extraction anchor moved.`);
  return lines.slice(start, end + 1).join("\n");
}

/**
 * Runs one bash process over all inputs, NUL-separated, calling mask() once per
 * input on exactly its bytes: the same as feeding each input on its own stdin.
 */
export function sedEngine(maskFn: string): Engine {
  const loop = `${maskFn}\nwhile IFS= read -r -d '' x; do printf '%s' "$x" | mask; printf '\\0'; done`;
  return (fragments) => {
    const inputs = fragments.map((f) => f.text);
    if (inputs.some((i) => i.includes("\0"))) throw new Error("an input carries a NUL, which is the separator");
    const out = execFileSync("bash", ["-c", loop], {
      input: inputs.map((i) => `${i}\0`).join(""),
      encoding: "utf8",
      maxBuffer: 1 << 30
    });
    const parts = out.split("\0");
    if (parts.pop() !== "" || parts.length !== inputs.length) {
      throw new Error(`the sed engine returned ${parts.length} outputs for ${inputs.length} inputs`);
    }
    return parts.map((text) => ({ text, status: "ok" }));
  };
}

export type Columns = {
  cases: number;
  new_leaked: string[];
  new_broken: string[];
  main_leaked: string[];
  main_broken: string[];
  fixed: string[];
  omitted: string[];
  copy_mismatch: string[];
};

/** Sorts every case into the columns in the header, against one sed copy as the reference. */
export function compare(cases: FuzzCase[], reference: Engine, other: Engine, candidate: Engine): Columns {
  const fragments = cases.map((c) => ({ text: c.input, kind: c.kind }));
  const ref = reference(fragments);
  const alt = other(fragments);
  const cand = candidate(fragments);
  if (cand.length !== cases.length)
    throw new Error(`the candidate returned ${cand.length} results for ${cases.length} inputs`);
  const col: Columns = {
    cases: cases.length,
    new_leaked: [],
    new_broken: [],
    main_leaked: [],
    main_broken: [],
    fixed: [],
    omitted: [],
    copy_mismatch: []
  };
  cases.forEach((c, i) => {
    if (ref[i]!.text !== alt[i]!.text) col.copy_mismatch.push(c.id);
    const bySed = judgeCase(c.input, ref[i]!, c.secrets, c.preserve);
    const byCand = judgeCase(c.input, cand[i]!, c.secrets, c.preserve);
    if (byCand.omitted) col.omitted.push(c.id);
    if (byCand.leaked.some((w) => !bySed.leaked.includes(w))) col.new_leaked.push(c.id);
    if (byCand.broken.some((w) => !bySed.broken.includes(w))) col.new_broken.push(c.id);
    if (byCand.leaked.some((w) => bySed.leaked.includes(w))) col.main_leaked.push(c.id);
    if (bySed.broken.length > 0) col.main_broken.push(c.id);
    if (bySed.leaked.some((w) => !byCand.leaked.includes(w))) col.fixed.push(c.id);
  });
  return col;
}

export { commandEngine, readable };

function main(argv: string[]): void {
  const arg = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) {
      if (fallback === undefined) throw new Error(`--${name} is required`);
      return fallback;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    return value;
  };
  // Number() reads "typo" as NaN and "" as 0, and a count of NaN or 0 generates no
  // cases, so the run would report nothing wrong without judging anything. Only
  // decimal digits are read, and the value is checked before any engine starts.
  const whole = (name: string, fallback?: string) => {
    const value = arg(name, fallback);
    if (!/^[0-9]+$/.test(value))
      throw new Error(`--${name} must be written in decimal digits, got ${JSON.stringify(value)}`);
    return Number(value);
  };
  const seed = whole("seed");
  if (seed > 0xffffffff)
    throw new Error(`--seed must be at most 4294967295, the generator's 32-bit state, got ${seed}`);
  const count = whole("count", "16000");
  if (!Number.isSafeInteger(count) || count === 0)
    throw new Error(`--count must be a positive safe integer, got ${count}`);
  const engine = commandEngine(arg("engine").split(" "), ROOT);
  const cases = generate(seed, count);
  const capture = sedEngine(shippedMask(SED_COPIES.capture));
  const archive = sedEngine(shippedMask(SED_COPIES.archive));
  for (const [name, ref, other] of [
    ["capture", capture, archive],
    ["archive", archive, capture]
  ] as const) {
    const col = compare(cases, ref, other, engine);
    if (col.new_leaked.length + col.new_broken.length + col.copy_mismatch.length > 0) process.exitCode = 1;
    const byFamily = (ids: string[]) => {
      const counts: Record<string, number> = {};
      for (const id of ids) {
        const f = cases.find((c) => c.id === id)!.family;
        counts[f] = (counts[f] ?? 0) + 1;
      }
      return counts;
    };
    console.log(
      JSON.stringify({
        reference: name,
        seed,
        cases: col.cases,
        new_leaked: col.new_leaked.length,
        new_broken: col.new_broken.length,
        main_leaked: col.main_leaked.length,
        main_broken: col.main_broken.length,
        fixed: col.fixed.length,
        omitted: col.omitted.length,
        copy_mismatch: col.copy_mismatch.length,
        new_leaked_by_family: byFamily(col.new_leaked),
        new_broken_by_family: byFamily(col.new_broken),
        main_leaked_by_family: byFamily(col.main_leaked),
        first: {
          new_leaked: col.new_leaked.slice(0, 3),
          new_broken: col.new_broken.slice(0, 3),
          copy_mismatch: col.copy_mismatch.slice(0, 3)
        }
      })
    );
  }
}

// Both sides are resolved: run through a symlink, argv[1] names the link and the
// module URL names the file, and a raw comparison skips main() and exits 0.
try {
  if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
    main(process.argv.slice(2));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}
