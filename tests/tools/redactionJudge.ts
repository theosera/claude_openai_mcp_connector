import { execFileSync } from "node:child_process";

/**
 * The judge shared by the migration gate (#249 step ②-2) and the differential fuzz.
 *
 * A redactor is judged on one case at a time, on three axes:
 *
 *   leaked   secret words still readable in the output
 *   broken   preserve words the output has fewer of than the input had
 *   omitted  the engine dropped the body instead of redacting it
 *
 * The engine is reached through its command line only, so the judge does not
 * depend on the language the engine is written in.
 */

export const MASK = "***MASKED***";

export type EngineResult = { text: string; status: string };
export type Engine = (inputs: string[]) => EngineResult[];
export type Verdict = { leaked: string[]; broken: string[]; omitted: boolean };

/**
 * Words still readable in `output`. Each mask token is replaced with a NUL first:
 * a secret word can occur inside the token itself, and would otherwise count as a
 * leak. Removing the token instead would join its two neighbours into a word that
 * is not in the output.
 */
export function readable(output: string, words: string[]): string[] {
  const text = output.split(MASK).join("\0");
  return words.filter((word) => text.includes(word));
}

/** Non-overlapping occurrences of `word` in `text`. */
export function occurrences(text: string, word: string): number {
  if (word.length === 0) throw new Error("an empty word matches everywhere and cannot be counted");
  return text.split(word).length - 1;
}

/**
 * Preserve words the output has fewer of than the input. Counted on the output as
 * it is, mask tokens included: a preserve word is never part of a token, and a
 * redactor that keeps one copy of a word the input had twice has still eaten one.
 */
export function broken(input: string, output: string, preserve: string[]): string[] {
  return preserve.filter((word) => occurrences(output, word) < occurrences(input, word));
}

/**
 * Judges one case. Every secret and preserve word must be in the input: a word the
 * input does not have is never leaked and never broken, so the case would be green
 * for any redactor at all. No preserve word may be part of a secret or contain one.
 *
 * An omitted body is reported as omitted, not as broken: dropping the body loses
 * every preserve word by construction. Its text is still read for secrets, so an
 * engine that says `omitted` but prints the input is charged with the leak.
 */
export function judgeCase(input: string, result: EngineResult, secrets: string[], preserve: string[]): Verdict {
  const absent = [...secrets, ...preserve].filter((word) => !input.includes(word));
  if (absent.length > 0) throw new Error(`words not in the input, so never judged: ${JSON.stringify(absent)}`);
  // A preserve word inside a secret (or the reverse) is lost by a correct redaction,
  // so its count drops and the case reads as broken for a reason that is not one.
  const tangled = preserve.filter((p) => secrets.some((s) => s.includes(p) || p.includes(s)));
  if (tangled.length > 0) throw new Error(`preserve words tangled with a secret: ${JSON.stringify(tangled)}`);
  const omitted = result.status === "omitted";
  return {
    leaked: readable(result.text, secrets),
    broken: omitted ? [] : broken(input, result.text, preserve),
    omitted
  };
}

/** Runs an engine through its command line: NDJSON strings in, NDJSON results out. */
export function commandEngine(argv: string[], cwd: string): Engine {
  return (inputs) => {
    const stdout = execFileSync(argv[0]!, argv.slice(1), {
      cwd,
      input: inputs.map((input) => `${JSON.stringify(input)}\n`).join(""),
      encoding: "utf8"
    });
    return stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as EngineResult);
  };
}
