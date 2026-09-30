/**
 * What step ②-3 of #249 leaves to step ②-4: secrets in argument position
 * (`mysql -p`, `redis-cli -a`, `curl -u`, including repeated, quoted and
 * continued forms and a `-p` in prose).
 *
 * The core does not mask these yet. Nothing calls the core, so the hooks keep
 * masking them with the sed `mask()` in the meantime. The lists are written out
 * so the checks below them can tell "not yet" from "got worse": a case or family
 * that is not listed here must be fully masked, and one that is listed must not
 * spread to anything else. Step ②-4 empties both lists.
 */

/** Corpus cases whose secrets sit in argument position. */
export const ARGUMENT_POSITION_CASES: ReadonlySet<string> = new Set([
  "A-Q1a",
  "A-Q1b",
  "A-Q1c",
  "A-Q1d",
  "A-Q2",
  "A-Q4",
  "A-F1a",
  "A-F1b",
  "A-F1c",
  "A-F4a",
  "A-F4b",
  "A-F5",
  "A-F6a",
  "A-F6b",
  "A-F6c",
  "A-C1",
  "C-S1",
  "C-S2",
  "C-S3",
  "C-S4",
  "C-S5",
  "J-E1",
  "J-E2",
  "J-Z5",
  "J-Z6",
  "G-234-1a",
  "G-234-1b",
  "G-234-1c",
  "G-234-1d",
  "G-234-2",
  "G-234-3a",
  "G-234-3b",
  "G-234-4",
  "G-234-c",
  "G-230-R1",
  "G-230-R2",
  "H-H03",
  "H-H04",
  "H-H05"
]);

/** Fuzz families whose secrets sit in argument position. */
export const ARGUMENT_POSITION_FAMILIES: ReadonlySet<string> = new Set([
  "mysql-p",
  "mysql-p-quoted",
  "redis-a",
  "curl-u",
  "prose-apostrophe"
]);
