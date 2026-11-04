import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { broken, readable } from "./tools/redactionJudge.js";
import { execFileSyncBounded } from "./tools/syncChild.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COPIES = [".claude/skills/ops-logging/capture-command.sh", ".claude/skills/session-archive/archive-session.sh"];
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const BASE_REVISION = "9eeed28e5ecc009fbce7dea9c2d5424179bf8d2b";
// Exact mask() bytes from BOTH hook blobs at BASE_REVISION, with no added LF.
const BASE_SHA256 = "617fa9d045214e0cb1c6515fbee280111480ddac9d7edbcf74b1ec35a6579805";
const BASE_BYTES = 54_425;
const base = readFileSync(join(ROOT, "tests/fixtures/log-redaction-s1-base-mask.sh"), "utf8");

function extracted(file: string): string {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const first = lines.indexOf("mask() {");
  const last = lines.findIndex((line, i) => i > first && line === "}");
  if (first < 0 || last <= first) throw new Error(`mask extraction failed: ${file}`);
  return lines.slice(first, last + 1).join("\n");
}

const masks = COPIES.map(extracted);
const sourceHashes = masks.map((source) => createHash("sha256").update(source).digest("hex"));

function run(source: string, input: string): string {
  return execFileSyncBounded(
    "/bin/bash",
    [
      "-c",
      `set -euo pipefail\n[ "$(command -v awk)" = /usr/bin/awk ]\n[ "$(command -v sed)" = /usr/bin/sed ]\n${source}\nmask`
    ],
    {
      cwd: ROOT,
      env: { ...process.env, PATH: SYSTEM_PATH },
      input,
      encoding: "utf8",
      timeout: 4000,
      maxBuffer: 1024 * 1024
    }
  );
}

function changed(source: string, before: string, after: string): string {
  expect(source.split(before), `unique mutation target: ${before}`).toHaveLength(2);
  return source.replace(before, after);
}

type Family = "H0" | "H1" | "H2" | "H3" | "H4";
type PreservationException =
  "sort-date-command" | "literal-output-text" | "container-host-option" | "explicit-entrypoint";
type Case = {
  id: string;
  family: Family;
  input: string;
  secrets: string[];
  preserve: string[];
  baseHidden?: boolean;
  exception?: PreservationException;
  publicCanaries?: string[];
};

const CASES: Case[] = [];
for (const [kind, client] of [
  ["unknown", "network-runner"],
  ["variable", "$HTTP_CLIENT"],
  ["braced-variable", "${HTTP_CLIENT}"],
  ["env-prefix", "env MODE=public network-runner"],
  ["command-prefix", "command network-runner"],
  ["sudo-prefix", "sudo -n network-runner"]
]) {
  for (const flag of ["-u", "--user", "--user="]) {
    const canary = `SYN_H0_${kind.replaceAll("-", "_")}_${flag === "-u" ? "SHORT" : flag.endsWith("=") ? "EQUAL" : "LONG"}_9`;
    CASES.push({
      id: `H0-${kind}-${flag}`,
      family: "H0",
      input: `${client} ${flag}${flag.endsWith("=") ? "" : " "}user:${canary} KEEP_H0`,
      secrets: [canary],
      preserve: [client, "KEEP_H0"],
      baseHidden: true
    });
  }
}

CASES.push(
  {
    id: "H0-unknown-clustered-attached",
    family: "H0",
    input: "network-runner -suuser:SYN_H0_CLUSTER_ATTACHED9 KEEP_CLUSTER",
    secrets: ["SYN_H0_CLUSTER_ATTACHED9"],
    preserve: ["network-runner", "KEEP_CLUSTER"]
  },
  {
    id: "H0-unknown-clustered-spaced",
    family: "H0",
    input: "network-runner -su user:SYN_H0_CLUSTER_SPACED9 KEEP_CLUSTER",
    secrets: ["SYN_H0_CLUSTER_SPACED9"],
    preserve: ["network-runner", "KEEP_CLUSTER"]
  },
  {
    id: "H0-literal-in-previous-command",
    family: "H0",
    input: String.raw`printf '\n'; echo curl -u user:SYN_H0_AFTER_LITERAL9 KEEP_AFTER`,
    secrets: ["SYN_H0_AFTER_LITERAL9"],
    preserve: [String.raw`printf '\n'; echo curl`, "KEEP_AFTER"],
    baseHidden: true
  },
  {
    id: "H0-empty-entrypoint-unknown-actual-command",
    family: "H0",
    input: 'docker run --entrypoint="" curlimages/curl:8 network-runner -u user:SYN_H0_EMPTY_ACTUAL9 KEEP_ACTUAL',
    secrets: ["SYN_H0_EMPTY_ACTUAL9"],
    preserve: ['--entrypoint=""', "network-runner", "KEEP_ACTUAL"],
    baseHidden: true
  },
  {
    id: "H0-escaped-leading-double-quote-sort",
    family: "H0",
    input: String.raw`\"sort -u user:SYN_H0_ESCAPED_SORT9 KEEP_ESCAPED`,
    secrets: ["SYN_H0_ESCAPED_SORT9"],
    preserve: [String.raw`\"sort`, "KEEP_ESCAPED"],
    baseHidden: true
  },
  {
    id: "H0-escaped-leading-apostrophe-date",
    family: "H0",
    input: String.raw`\'date --user user:SYN_H0_ESCAPED_DATE9 KEEP_ESCAPED`,
    secrets: ["SYN_H0_ESCAPED_DATE9"],
    preserve: [String.raw`\'date`, "KEEP_ESCAPED"],
    baseHidden: true
  },
  {
    id: "H0-single-quoted-literal-backslash-sort",
    family: "H0",
    input: String.raw`'so\rt' -u user:SYN_H0_SQ_BACKSLASH9 KEEP_SLASH`,
    secrets: ["SYN_H0_SQ_BACKSLASH9"],
    preserve: [String.raw`'so\rt'`, "KEEP_SLASH"],
    baseHidden: true
  },
  {
    id: "H0-single-quoted-literal-backslash-date",
    family: "H0",
    input: String.raw`'da\te' -u user:SYN_H0_SQ_DATE9 KEEP_SLASH`,
    secrets: ["SYN_H0_SQ_DATE9"],
    preserve: [String.raw`'da\te'`, "KEEP_SLASH"],
    baseHidden: true
  },
  {
    id: "H0-double-quoted-literal-backslash-sort",
    family: "H0",
    input: String.raw`"so\rt" -u user:SYN_H0_DQ_BACKSLASH9 KEEP_SLASH`,
    secrets: ["SYN_H0_DQ_BACKSLASH9"],
    preserve: [String.raw`"so\rt"`, "KEEP_SLASH"],
    baseHidden: true
  },
  {
    id: "H0-single-quoted-literal-backslash-entrypoint",
    family: "H0",
    input: String.raw`docker run --entrypoint 'so\rt' curlimages/curl:8 -u user:SYN_H0_ENTRY_BACKSLASH9 KEEP_ENTRY_SLASH`,
    secrets: ["SYN_H0_ENTRY_BACKSLASH9"],
    preserve: [String.raw`--entrypoint 'so\rt'`, "KEEP_ENTRY_SLASH"],
    baseHidden: true
  },
  {
    id: "H0-empty-entrypoint-command-after-first-flag",
    family: "H0",
    input:
      'docker run --entrypoint="" curlimages/curl:8 -v network-runner -u user:SYN_H0_EMPTY_AFTER_FLAG9 KEEP_EMPTY_FLAG',
    secrets: ["SYN_H0_EMPTY_AFTER_FLAG9"],
    preserve: ["network-runner", "KEEP_EMPTY_FLAG"],
    baseHidden: true
  },
  {
    id: "H0-empty-entrypoint-command-after-first-user-value",
    family: "H0",
    input:
      'docker run --entrypoint="" curlimages/curl:8 -u source:dest network-runner -u user:SYN_H0_EMPTY_AFTER_VALUE9 KEEP_EMPTY_USER',
    secrets: ["SYN_H0_EMPTY_AFTER_VALUE9"],
    preserve: ["network-runner", "KEEP_EMPTY_USER"],
    baseHidden: true
  }
);

for (const [kind, command, baseHidden] of [
  ["known-separated", "curl -u user:", true],
  ["known-attached", "curl -uuser:", false],
  ["known-long-attached", "curl --user=user:", true],
  ["unknown-separated", "network-runner -u user:", true]
] as const) {
  const canary = `SYN_H0_URI_${kind.replaceAll("-", "_")}_9`;
  CASES.push({
    id: `H0-uri-looking-password-${kind}`,
    family: "H0",
    input: `${command}//${canary} KEEP_URI`,
    secrets: [canary],
    preserve: ["user:", "KEEP_URI"],
    baseHidden
  });
}

CASES.push({
  id: "H0-quoted-redis-url-whitespace-password",
  family: "H0",
  input: 'redis-cli -u "redis://user:SYN_H0_URI_HEAD9 SYN_H0_URI_TAIL9@host.invalid:6379/0" ping KEEP_URI',
  secrets: ["SYN_H0_URI_HEAD9", "SYN_H0_URI_TAIL9"],
  preserve: ["redis://user:", "@host.invalid:6379/0", "ping", "KEEP_URI"]
});

for (const [kind, executable] of [
  ["expanded", '"${HTTP_CLIENT}"'],
  ["array-expanded", '"${HTTP_COMMAND[@]}"'],
  ["prefixed-expanded", 'env MODE=public "${HTTP_CLIENT}"'],
  ["prefixed-alias", "command /opt/synthetic/curl.exe"],
  ["absolute-alias", "/opt/synthetic/curl.exe"],
  ["container-image", "docker run --rm curlimages/curl:8"]
]) {
  for (const [flagKind, flag] of [
    ["attached", "-uuser:"],
    ["clustered", "-suuser:"],
    ["long", "--user=user:"]
  ]) {
    const canary = `SYN_H2_${kind.replaceAll("-", "_")}_${flagKind}_9`;
    CASES.push({
      id: `H2-${kind}-${flagKind}`,
      family: "H2",
      input: `${executable} ${flag}${canary} https://example.invalid/ KEEP_H2`,
      secrets: [canary],
      preserve: ["https://example.invalid/", "KEEP_H2"]
    });
  }
}

for (const [kind, input, secrets] of [
  [
    "whole-double",
    '<x token="SYN_H3_WHOLE_HEAD9 SYN_H3_WHOLE_TAIL9"> KEEP_H3',
    ["SYN_H3_WHOLE_HEAD9", "SYN_H3_WHOLE_TAIL9"]
  ],
  [
    "whole-single",
    "<x token='SYN_H3_SINGLE_HEAD9 SYN_H3_SINGLE_TAIL9'> KEEP_H3",
    ["SYN_H3_SINGLE_HEAD9", "SYN_H3_SINGLE_TAIL9"]
  ],
  ["closed-glued-double", '<x token="SYN_H3_HEAD9"SYN_H3_TAIL9> KEEP_H3', ["SYN_H3_HEAD9", "SYN_H3_TAIL9"]],
  ["closed-glued-single", "<x token='SYN_H3_SQ_HEAD9'SYN_H3_SQ_TAIL9> KEEP_H3", ["SYN_H3_SQ_HEAD9", "SYN_H3_SQ_TAIL9"]],
  [
    "closing-quote-double",
    '<x note="token: SYN_H3_CLOSING9"SYN_H3_AFTER9> KEEP_H3',
    ["SYN_H3_CLOSING9", "SYN_H3_AFTER9"]
  ],
  [
    "closing-quote-single",
    "<x note='token: SYN_H3_SQ_CLOSE9'SYN_H3_SQ_AFTER9> KEEP_H3",
    ["SYN_H3_SQ_CLOSE9", "SYN_H3_SQ_AFTER9"]
  ],
  [
    "keyword-in-quoted-attribute",
    '<x note="token: SYN_H3_NESTED_HEAD9 SYN_H3_NESTED_TAIL9"> KEEP_H3',
    ["SYN_H3_NESTED_HEAD9", "SYN_H3_NESTED_TAIL9"]
  ],
  [
    "unclosed-double-value",
    '<x token="SYN_H3_OPEN_HEAD9 SYN_H3_OPEN_TAIL9> KEEP_H3',
    ["SYN_H3_OPEN_HEAD9", "SYN_H3_OPEN_TAIL9"]
  ],
  [
    "unclosed-single-value",
    "<x token='SYN_H3_SQ_OPEN_HEAD9 SYN_H3_SQ_OPEN_TAIL9> KEEP_H3",
    ["SYN_H3_SQ_OPEN_HEAD9", "SYN_H3_SQ_OPEN_TAIL9"]
  ],
  [
    "value-opening-at-attribute-close",
    '<x note="token: "SYN_H3_BOUNDARY_HEAD9 SYN_H3_BOUNDARY_TAIL9> KEEP_H3',
    ["SYN_H3_BOUNDARY_HEAD9", "SYN_H3_BOUNDARY_TAIL9"]
  ],
  [
    "quoted-scheme-joined-tail",
    '<x note="token: Basic SYN_H3_SCHEME_JOIN_HEAD9"SYN_H3_SCHEME_JOIN_TAIL9> KEEP_H3',
    ["SYN_H3_SCHEME_JOIN_HEAD9", "SYN_H3_SCHEME_JOIN_TAIL9"]
  ],
  [
    "quoted-scheme-spaced-tail",
    '<x note="token: Basic SYN_H3_SCHEME_SPACE_HEAD9 SYN_H3_SCHEME_SPACE_TAIL9"> KEEP_H3',
    ["SYN_H3_SCHEME_SPACE_HEAD9", "SYN_H3_SCHEME_SPACE_TAIL9"]
  ]
] as const) {
  CASES.push({ id: `H3-${kind}`, family: "H3", input, secrets: [...secrets], preserve: [">", "KEEP_H3"] });
}

CASES.push({
  id: "H3-structural-input-password-type",
  family: "H3",
  input: '<input value="SYN_H3_HTML_VALUE9" type="password" data-passphrase="PUBLIC_HTML9"> KEEP_HTML',
  secrets: ["SYN_H3_HTML_VALUE9"],
  preserve: ["KEEP_HTML"],
  baseHidden: true
});

for (const scheme of [false, true]) {
  for (const angle of [false, true]) {
    const kind = `${scheme ? "scheme" : "bare"}-${angle ? "angle" : "record-end"}`;
    const head = `SYN_H3_OUTER_${kind.replaceAll("-", "_")}_HEAD9`;
    const tail = `SYN_H3_OUTER_${kind.replaceAll("-", "_")}_TAIL9`;
    CASES.push({
      id: `H3-unclosed-outer-attribute-${kind}`,
      family: "H3",
      input: `<x note="token: ${scheme ? "Basic " : ""}${head} ${tail}${angle ? "> KEEP_OUTER" : ""}`,
      secrets: [head, tail],
      preserve: angle ? [">", "KEEP_OUTER"] : []
    });
  }
}

for (const [client, prefix] of [
  ["curl", "curl -u user:"],
  ["mysql", "mysql -p"],
  ["redis", "redis-cli -a "]
]) {
  for (const [kind, value] of [
    ["opening-brace", "{SYN_H4_HEAD9 SYN_H4_TAIL9"],
    ["closing-brace", "}SYN_H4_HEAD9 SYN_H4_TAIL9"],
    ["balanced-braces", "{SYN_H4_HEAD9} SYN_H4_TAIL9"]
  ]) {
    CASES.push({
      id: `H4-${client}-${kind}`,
      family: "H4",
      input: `${prefix}"${value}" KEEP_H4`,
      secrets: ["SYN_H4_HEAD9", "SYN_H4_TAIL9"],
      preserve: [client === "redis" ? "redis-cli" : client, "KEEP_H4"]
    });
  }
  CASES.push({
    id: `H4-${client}-quoted-tail-beyond-subregion`,
    family: "H4",
    input: `echo "$( ${prefix}'SYN_H4_REGION_HEAD9 SYN_H4_REGION_TAIL9' KEEP_INNER )" KEEP_H4`,
    secrets: ["SYN_H4_REGION_HEAD9", "SYN_H4_REGION_TAIL9"],
    preserve: ["KEEP_INNER", "KEEP_H4"]
  });
  CASES.push(
    {
      id: `H4-${client}-non-command-braces`,
      family: "H4",
      input: `echo prefix{${prefix}SYN_H4_BRACE9 KEEP_INNER} KEEP_H4`,
      secrets: ["SYN_H4_BRACE9"],
      preserve: ["KEEP_INNER", "KEEP_H4"],
      baseHidden: true
    },
    {
      id: `H4-${client}-quote-closes-outside-region`,
      family: "H4",
      input: `echo '" ${prefix}SYN_H4_PARTIAL9' "outside" KEEP_H4`,
      secrets: ["SYN_H4_PARTIAL9"],
      preserve: ['"outside"', "KEEP_H4"],
      baseHidden: true
    }
  );
}

const PUBLIC_CASES: Case[] = [
  {
    id: "H0-sort-command",
    family: "H0",
    input: "sort -u source:SYN_H0_SORT_PUBLIC9 KEEP_SORT",
    secrets: [],
    preserve: ["sort -u source:SYN_H0_SORT_PUBLIC9 KEEP_SORT"],
    publicCanaries: ["SYN_H0_SORT_PUBLIC9"],
    exception: "sort-date-command"
  },
  {
    id: "H0-date-command",
    family: "H0",
    input: "date -u '+%Y-%m-%dT%H:%M' KEEP_DATE",
    secrets: [],
    preserve: ["date -u '+%Y-%m-%dT%H:%M' KEEP_DATE"],
    exception: "sort-date-command"
  },
  {
    id: "H0-escaped-echo-literal",
    family: "H0",
    input: String.raw`echo KEEP_PRE\ncurl -u source:SYN_H0_ECHO_PUBLIC9 KEEP_ECHO`,
    secrets: [],
    preserve: [String.raw`echo KEEP_PRE\ncurl -u source:SYN_H0_ECHO_PUBLIC9 KEEP_ECHO`],
    publicCanaries: ["SYN_H0_ECHO_PUBLIC9"],
    exception: "literal-output-text"
  },
  {
    id: "H0-printf-literal",
    family: "H0",
    input: String.raw`printf \ncurl -u source:SYN_H0_PRINTF_PUBLIC9 KEEP_PRINTF`,
    secrets: [],
    preserve: [String.raw`printf \ncurl -u source:SYN_H0_PRINTF_PUBLIC9 KEEP_PRINTF`],
    publicCanaries: ["SYN_H0_PRINTF_PUBLIC9"],
    exception: "literal-output-text"
  },
  {
    id: "H0-container-host-user",
    family: "H0",
    input: "docker run -u SYN_H0_HOST9:SYN_H0_GROUP9 alpine true KEEP_HOST",
    secrets: [],
    preserve: ["docker run -u SYN_H0_HOST9:SYN_H0_GROUP9 alpine true KEEP_HOST"],
    publicCanaries: ["SYN_H0_GROUP9"],
    exception: "container-host-option"
  },
  {
    id: "H0-container-sort-entrypoint",
    family: "H0",
    input: "docker run --entrypoint sort curlimages/curl:8 -u source:SYN_H0_ENTRY_PUBLIC9 KEEP_ENTRY",
    secrets: [],
    preserve: ["docker run --entrypoint sort curlimages/curl:8 -u source:SYN_H0_ENTRY_PUBLIC9 KEEP_ENTRY"],
    publicCanaries: ["SYN_H0_ENTRY_PUBLIC9"],
    exception: "explicit-entrypoint"
  },
  {
    id: "H0-container-empty-entrypoint",
    family: "H0",
    input: 'docker run --entrypoint="" curlimages/curl:8 -u source:SYN_H0_EMPTY_PUBLIC9 KEEP_EMPTY',
    secrets: [],
    preserve: ['docker run --entrypoint="" curlimages/curl:8 -u source:SYN_H0_EMPTY_PUBLIC9 KEEP_EMPTY'],
    publicCanaries: ["SYN_H0_EMPTY_PUBLIC9"],
    exception: "explicit-entrypoint"
  }
];

function rendererCase(client: "curl" | "mysql" | "redis", ending: "LF" | "CRLF"): Case {
  const script = readFileSync(join(ROOT, COPIES[1]!), "utf8").split("\n");
  const part = (anchor: string) => {
    const first = script.indexOf(anchor);
    const last = script.findIndex((line, i) => i > first && line === "'");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    return script.slice(first + 1, last).join("\n");
  };
  const program = part("fence_jq='") + "\n" + part('body_jq="$fence_jq"\'');
  const canary = `SYN_H1_${client}_${ending}_9`;
  const command = {
    curl: ["curl", `--user user:${canary} https://example.invalid/`],
    mysql: ["mysql", `-p${canary} db`],
    redis: ["redis-cli", `-a ${canary} ping`]
  }[client];
  const transcript = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "SyntheticContinuationTool",
            input: {
              command: `echo KEEP_ROUTE\n${command[0]} \\${ending === "LF" ? "\n" : "\r\n"} ${command[1]} KEEP_H1`
            }
          }
        ]
      }
    }
  ];
  const input = execFileSyncBounded("jq", ["-r", program], {
    input: JSON.stringify(transcript),
    encoding: "utf8",
    timeout: 4000,
    maxBuffer: 64 * 1024
  });
  expect(input).toContain(ending === "LF" ? String.raw`\\\n` : String.raw`\\\r\n`);
  return {
    id: `H1-actual-tojson-${client}-${ending}`,
    family: "H1",
    input,
    secrets: [canary],
    preserve: ["SyntheticContinuationTool", "KEEP_ROUTE", "KEEP_H1"]
  };
}

function requireHidden(output: string, c: Case): void {
  expect(readable(output, c.secrets), `${c.id}: original credential guard`).toEqual([]);
  expect(broken(c.input, output, c.preserve), `${c.id}: public controls`).toEqual([]);
}

function beforeLegacySed(source: string): string {
  const boundary = "\n  ' |\n  sed -E \\\n";
  expect(source.split(boundary), "first collector / legacy sed boundary").toHaveLength(2);
  return source.slice(0, source.indexOf(boundary)) + "\n  '\n}";
}

function requireGuard(
  source: string,
  cases: Case[],
  before: string,
  after: string,
  exposed: (c: Case) => string[] = (c) => c.secrets
): void {
  expect(cases.length, "guard mutation has a nonempty fixture set").toBeGreaterThan(0);
  for (const c of cases) requireHidden(run(source, c.input), c);
  const mutant = changed(source, before, after);
  for (const c of cases) {
    const output = run(mutant, c.input);
    const expected = exposed(c);
    expect(expected.length, `${c.id}: mutation expects an actual canary`).toBeGreaterThan(0);
    expect(readable(output, expected), `${c.id}: selective mutation reaches canary`).toEqual(expected);
    expect(broken(c.input, output, c.preserve), `${c.id}: selective mutation retains controls`).toEqual([]);
    expect(() => requireHidden(output, c)).toThrow(`${c.id}: original credential guard`);
  }
}

function measured(file: string, name: string, check: () => void): void {
  it(
    name,
    () => {
      const tick = performance.now();
      let outcome = "failed";
      try {
        check();
        outcome = "passed";
      } finally {
        process.stdout.write(
          JSON.stringify({
            measurement: "S1-DEFAULT-TEST",
            file,
            name,
            elapsedMs: performance.now() - tick,
            outcome,
            runtime: { node: process.version, platform: process.platform, arch: process.arch },
            baseRevision: BASE_REVISION,
            baseSha256: BASE_SHA256,
            sourceHashes,
            scope: "callback assertions; final Vitest result is checked separately"
          }) + "\n"
        );
      }
    },
    120_000
  );
}

measured("base", "pins the complete baseline mask used for every same-input comparison", () => {
  expect(Buffer.byteLength(base)).toBe(BASE_BYTES);
  expect(createHash("sha256").update(base).digest("hex")).toBe(BASE_SHA256);
  expect(base.startsWith("mask() {\n")).toBe(true);
  expect(base.endsWith("\n}")).toBe(true);
  expect(run(base, "network-runner -u user:SYN_BASE_CONTROL9 KEEP_BASE")).not.toContain("SYN_BASE_CONTROL9");
});

for (const [index, file] of COPIES.entries()) {
  const source = masks[index]!;
  describe(`S1 default masking: ${file}`, () => {
    for (const family of ["H0", "H2", "H3", "H4"] as const) {
      measured(file, `${family} masks synthetic credential fixture classes and retains public controls`, () => {
        const cases = CASES.filter((c) => c.family === family);
        expect(cases.length, `${family}: nonempty fixtures`).toBeGreaterThan(0);
        for (const c of cases) requireHidden(run(source, c.input), c);
      });
    }

    measured(file, "H1 masks actual non-Bash tojson continuations for all three clients", () => {
      for (const ending of ["LF", "CRLF"] as const)
        for (const client of ["curl", "mysql", "redis"] as const) {
          const c = rendererCase(client, ending);
          requireHidden(run(source, c.input), c);
        }
    });

    measured(file, "H0 retains the finite current public command exceptions", () => {
      for (const c of PUBLIC_CASES) expect(run(source, c.input), c.id).toBe(c.input);
    });

    measured(file, "H0 default alone masks an unknown client that legacy client recognition cannot read", () => {
      const c = CASES.find((item) => item.id === "H0-unknown--u")!;
      requireHidden(run(source, c.input), c);
      const mutant = changed(
        source,
        "return s1_h0_active && !s1_h0_public[level]",
        "return 0 && s1_h0_active && !s1_h0_public[level]"
      );
      const output = run(mutant, c.input);
      expect(readable(output, c.secrets), "H0-only mutation reaches unknown-client canary").toEqual(c.secrets);
      expect(() => requireHidden(output, c)).toThrow(`${c.id}: original credential guard`);
    });

    measured(file, "H0 preflight guard alone prevents clustered unknown-client flags from skipping collection", () => {
      requireGuard(
        source,
        CASES.filter((c) => c.id === "H0-unknown-clustered-attached" || c.id === "H0-unknown-clustered-spaced"),
        "if (s1_h0_active || s1_continued",
        "if (0 && s1_h0_active || s1_continued"
      );
    });

    measured(file, "H0 command quote handling keeps escaped quotes in executable names", () => {
      requireGuard(
        source,
        CASES.filter((c) => c.id.startsWith("H0-escaped-leading-")),
        String.raw`        word = word c
      }
      return quote || j <= last ? "" : word`,
        String.raw`        if (c != "\"" && c != s1_apostrophe) word = word c
      }
      return quote || j <= last ? "" : word`
      );
    });

    measured(file, "H0 empty-entrypoint public pending state ends before a later actual command", () => {
      requireGuard(
        source,
        CASES.filter((c) => c.id.startsWith("H0-empty-entrypoint-command-after-first-")),
        String.raw`      if (s1_h0_image_command[level] == 2) { s1_h0_image_command[level] = 1; return }
      if (s1_h0_image_command[level] && s1_h0_public[level]) {
        if (last - first == 1 && s1_at(first, "-u")) { s1_h0_image_command[level] = 2; return }
        if (last - first > 1 && s1_at(first, "-p")) return
      }`,
        String.raw`      if (s1_h0_image_command[level] && s1_h0_public[level] && original_bytes[first] == "-") { s1_h0_image_command[level] = 0; return }`
      );
    });

    measured(file, "H0 confines the URL host preservation branch to recognized redis userinfo", () => {
      const c = CASES.find((item) => item.id === "H0-quoted-redis-url-whitespace-password")!;
      requireHidden(run(source, c.input), c);
      const mutant = changed(
        source,
        'if (redis_url && s1_at(colon, "://"))',
        'if (0 && redis_url && s1_at(colon, "://"))'
      );
      const output = run(mutant, c.input);
      expect(readable(output, c.secrets), "generic user values still mask the credential").toEqual([]);
      expect(broken(c.input, output, c.preserve), "redis URL host preservation guard is reached").toContain(
        "@host.invalid:6379/0"
      );
      expect(() => requireHidden(output, c)).toThrow(`${c.id}: public controls`);
    });

    measured(file, "H0 treats URI-looking curl and unknown-client password bytes as credentials", () => {
      requireGuard(
        source,
        CASES.filter((c) => c.id.startsWith("H0-uri-looking-password-")),
        String.raw`      s1_value(colon + 1, last)
    }
    function s1_h0_default`,
        String.raw`      if (s1_at(colon, "://")) return
      s1_value(colon + 1, last)
    }
    function s1_h0_default`
      );
    });

    measured(file, "H1 continuation guard alone retains the serialized mysql and redis command context", () => {
      // Curl is asserted above through the actual renderer too. H0 can mask its
      // -u value independently, so mysql/redis make this selective mutant red.
      const cases = (["LF", "CRLF"] as const).flatMap((ending) =>
        (["mysql", "redis"] as const).map((client) => rendererCase(client, ending))
      );
      requireGuard(source, cases, "return s1_json_continuations[at]", "return 0 && s1_json_continuations[at]");
    });

    measured(file, "H2 default guard covers prefixed expansions and aliases beyond the old client guard", () => {
      requireGuard(
        source,
        CASES.filter((c) => c.id === "H2-prefixed-expanded-clustered" || c.id === "H2-prefixed-alias-clustered"),
        "return s1_h0_active && !s1_h0_public[level]",
        "return 0 && s1_h0_active && !s1_h0_public[level]"
      );
    });

    measured(file, "H3 quoted-value guard masks glued tails inside a tag", () => {
      requireGuard(
        source,
        CASES.filter((c) => c.id === "H3-closed-glued-double" || c.id === "H3-closed-glued-single"),
        "if (in_tag) { s1_tag_quoted_tail(j, j); return }",
        "if (0 && in_tag) { s1_tag_quoted_tail(j, j); return }",
        (c) => [c.secrets[1]!]
      );
    });

    measured(
      file,
      "H3 enclosing-attribute guard masks keyword values through their closing quote and glued tail",
      () => {
        requireGuard(
          source,
          CASES.filter((c) => c.id === "H3-keyword-in-quoted-attribute" || c.id === "H3-closing-quote-double"),
          "else s1_tag_quoted_tail(s1_keyword_tag_start, s1_keyword_tag_start)",
          "else s1_range(j, j - 1)",
          (c) => [c.secrets[1]!]
        );
      }
    );

    measured(file, "H3 unclosed-tag quote guard masks the value before the next angle", () => {
      requireGuard(
        source,
        CASES.filter((c) => c.id === "H3-unclosed-double-value" || c.id === "H3-value-opening-at-attribute-close"),
        "if (in_tag) { s1_range(j + 1, s1_tag_end(j) - 1); return }",
        "if (0 && in_tag) { s1_range(j + 1, s1_tag_end(j) - 1); return }",
        (c) => [c.secrets[1]!]
      );
    });

    measured(file, "H3 quoted authentication-scheme guard masks joined and spaced attribute tails", () => {
      requireGuard(
        source,
        CASES.filter((c) => c.id.startsWith("H3-quoted-scheme-")),
        "if (in_tag && s1_keyword_tag_quote && !s1_probe_only) { s1_tag_quoted_tail(s1_keyword_tag_start, s1_keyword_tag_start); return }",
        "if (0 && in_tag && s1_keyword_tag_quote && !s1_probe_only) { s1_tag_quoted_tail(s1_keyword_tag_start, s1_keyword_tag_start); return }",
        (c) => [c.secrets[1]!]
      );
    });

    measured(file, "H3 unmatched outer-attribute guard masks through its angle or physical record end", () => {
      requireGuard(
        source,
        CASES.filter((c) => c.id.startsWith("H3-unclosed-outer-attribute-")),
        "last = !qend ? tag_end - 1 :",
        "last = 0 && !qend ? tag_end - 1 :",
        (c) => [c.secrets[1]!]
      );
    });

    measured(file, "H3 keeps the HTML password type structural so later masking can hide its value", () => {
      const c = CASES.find((item) => item.id === "H3-structural-input-password-type")!;
      const collector = run(beforeLegacySed(source), c.input);
      expect(collector, "original password type reaches the later HTML guard").toContain('type="password"');
      expect(collector, "the password input value is still present before the HTML stage").toContain(c.secrets[0]!);
      requireGuard(
        source,
        [c],
        String.raw`if (in_tag && s1_keyword_tag_quote && !explicit && (original_bytes[after - 1] == "\"" || original_bytes[after - 1] == s1_apostrophe)) return`,
        String.raw`if (0 && in_tag && s1_keyword_tag_quote && !explicit && (original_bytes[after - 1] == "\"" || original_bytes[after - 1] == s1_apostrophe)) return`
      );
    });

    measured(file, "H4 brace-region guard alone scans clients inside non-command braces", () => {
      requireGuard(
        source,
        CASES.filter((c) => c.id === "H4-mysql-non-command-braces" || c.id === "H4-redis-non-command-braces"),
        '} else if (c == "{" && (qend = s1_braces[j])) {',
        '} else if (0 && c == "{" && (qend = s1_braces[j])) {'
      );
    });

    measured(file, "H4 partial-quote guard alone scans a quote whose close lies beyond the current region", () => {
      requireGuard(
        source,
        CASES.filter((c) => c.id.endsWith("-quote-closes-outside-region")),
        "else if (qend > end && j < end) { s1_scan(j + 1, end, level + 1); j = end }",
        "else if (0 && qend > end && j < end) { s1_scan(j + 1, end, level + 1); j = end }"
      );
    });

    measured(file, "preserves every base-hidden canary on the same inputs except enumerated public exceptions", () => {
      const cases = [
        ...CASES,
        ...PUBLIC_CASES,
        ...(["LF", "CRLF"] as const).flatMap((ending) =>
          (["curl", "mysql", "redis"] as const).map((client) => rendererCase(client, ending))
        )
      ];
      let baseHiddenCanaries = 0;
      const reachedFamilies = new Set<Family>();
      for (const c of cases) {
        const before = run(base, c.input);
        const after = run(source, c.input);
        const previouslyHidden = [...c.secrets, ...(c.publicCanaries ?? [])].filter(
          (canary) => !readable(before, [canary]).length
        );
        if (c.baseHidden) expect(previouslyHidden, `${c.id}: base masking positive control`).toEqual(c.secrets);
        reachedFamilies.add(c.family);
        baseHiddenCanaries += previouslyHidden.length;
        if (c.exception) {
          expect(c.secrets, `${c.id}: public exception cannot authorize a credential leak`).toEqual([]);
          expect(after, c.id).toBe(c.input);
        } else {
          expect(readable(after, previouslyHidden), `${c.id}: no newly clear base-masked canary`).toEqual([]);
          requireHidden(after, c);
        }
      }
      expect([...reachedFamilies].sort()).toEqual(["H0", "H1", "H2", "H3", "H4"]);
      expect(baseHiddenCanaries, "same-input base comparison reached known masked canaries").toBeGreaterThanOrEqual(18);
      process.stdout.write(
        JSON.stringify({ measurement: "S1-DEFAULT-BASE-COMPAT", file, inputs: cases.length, baseHiddenCanaries }) + "\n"
      );
    });
  });
}

measured("both", "keeps the two complete shipping masks identical for the tested implementation", () => {
  expect(masks[0]).toBe(masks[1]);
  expect(sourceHashes[0]).toBe(sourceHashes[1]);
});
