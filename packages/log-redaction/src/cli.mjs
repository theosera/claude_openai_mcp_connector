#!/usr/bin/env node
/**
 * The core's command line: one JSON object `{ "text": …, "kind": … }` per line on
 * stdin, one `{ text, status }` (plus `reason` when omitted) per line on stdout,
 * in the same order.
 *
 * A line that is not JSON, or not an object with a string `text` and a `kind`
 * from `KINDS`, is answered with an omission. Nothing is ever answered with its
 * input.
 */

import { Buffer } from "node:buffer";
import process from "node:process";

import { omitted, redactFragment } from "./core.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const lines = Buffer.concat(chunks)
  .toString("utf8")
  .split("\n")
  .filter((line) => line.length > 0);

for (const line of lines) {
  let fragment;
  try {
    fragment = JSON.parse(line);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ text: omitted("fragment_not_json"), status: "omitted", reason: "fragment_not_json" })}\n`
    );
    continue;
  }
  process.stdout.write(`${JSON.stringify(redactFragment(fragment))}\n`);
}
