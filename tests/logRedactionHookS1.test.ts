import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { broken, readable } from "./tools/redactionJudge.js";
import { execFileSyncBounded } from "./tools/syncChild.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COPIES = [".claude/skills/ops-logging/capture-command.sh", ".claude/skills/session-archive/archive-session.sh"];
function extracted(file: string): string {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const start = lines.indexOf("mask() {");
  const end = lines.findIndex((line, i) => i > start && line === "}");
  if (start < 0 || end < 0) throw new Error(`mask extraction failed: ${file}`);
  return lines.slice(start, end + 1).join("\n");
}
function run(source: string, input: string): string {
  return execFileSyncBounded("bash", ["-c", `set -o pipefail\n${source}\nmask`], {
    input,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024
  });
}
function changed(source: string, before: string, after: string): string {
  expect(source.split(before), `unique mutation target: ${before}`).toHaveLength(2);
  return source.replace(before, after);
}

type Case = { id: string; input: string; secrets: string[]; preserve: string[] };
const REGRESSION_CASES: Case[] = [
  {
    id: "env-glued-unquoted-tail",
    input: 'PASSWORD="HEADZZ9"TAILZZ9 KEEP_S1_ENV',
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["PASSWORD=", "KEEP_S1_ENV"]
  },
  {
    id: "env-adjacent-single-quotes",
    input: "PASSWORD='HEADZZ9''TAILZZ9' KEEP_S1_ENV_SQ",
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["PASSWORD=", "KEEP_S1_ENV_SQ"]
  },
  {
    id: "passphrase-adjacent-mixed-quotes",
    input: "gpg --passphrase \"HEADZZ9\"'TAILZZ9' KEEP_S1_ADJ",
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["gpg", "KEEP_S1_ADJ"]
  },
  {
    id: "mysql-glued-quoted-tail",
    input: "mysql -p'HEADZZ9'TAILZZ9 db KEEP_S1_MYSQL",
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["mysql", "db", "KEEP_S1_MYSQL"]
  },
  {
    id: "mysql-mixed-quoted-tail",
    input: 'mysql -pHEADZZ9"TAILZZ9" db KEEP_S1_MYSQL_DQ',
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["mysql", "db", "KEEP_S1_MYSQL_DQ"]
  },
  {
    id: "passphrase-glued-command-substitution",
    input: "gpg --passphrase HEADZZ9$(printf TAILZZ9) KEEP_S1_SUB",
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["gpg", "KEEP_S1_SUB"]
  },
  {
    id: "redis-glued-command-substitution",
    input: "redis-cli -a HEADZZ9$(printf TAILZZ9) ping KEEP_S1_REDIS_SUB",
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["redis-cli", "ping", "KEEP_S1_REDIS_SUB"]
  },
  {
    id: "curl-glued-backtick-substitution",
    input: "curl -u user:HEADZZ9`printf TAILZZ9` https://example.test/ KEEP_S1_CURL_SUB",
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["curl", "user:", "https://example.test/", "KEEP_S1_CURL_SUB"]
  },
  {
    id: "unclosed-html-password-attribute",
    input: '<password first="HEADZZ9" second="TAILZZ9> KEEP_S1_HTML',
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["KEEP_S1_HTML"]
  },
  {
    id: "overlapping-passphrase-keyword",
    input: 'gpg --passphrase "HEADZZ9 token: TAILZZ9" KEEP_S1_OVERLAP',
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["gpg", "KEEP_S1_OVERLAP"]
  },
  {
    id: "overlapping-passphrase-escaped-quote",
    input: 'gpg --passphrase "HEADZZ9 key: \\" TAILZZ9" KEEP_S1_ESC',
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["gpg", "KEEP_S1_ESC"]
  },
  {
    id: "xml-client-command",
    input: "<command>mysql -pHEADZZ9 db</command> KEEP_S1_XML",
    secrets: ["HEADZZ9"],
    preserve: ["KEEP_S1_XML"]
  },
  {
    id: "xml-redis-command",
    input: '<command>redis-cli -a "HEADZZ9 TAILZZ9" ping</command> KEEP_S1_XML_REDIS',
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["KEEP_S1_XML_REDIS"]
  },
  {
    id: "url-keyword-password",
    input: "https://user:password=HEADZZ9@host/path KEEP_S1_URL",
    secrets: ["HEADZZ9"],
    preserve: ["https://user:", "@host/path", "KEEP_S1_URL"]
  },
  {
    id: "redis-client-valued-credential",
    input: "redis-cli -a mysql ping KEEP_S1_VALUE",
    secrets: ["mysql"],
    preserve: ["redis-cli", "ping", "KEEP_S1_VALUE"]
  },
  {
    id: "redis-client-valued-long-credential",
    input: "redis-cli --pass curl ping KEEP_S1_VALUE_LONG",
    secrets: ["curl"],
    preserve: ["redis-cli", "ping", "KEEP_S1_VALUE_LONG"]
  },
  {
    id: "absolute-path-client",
    input: "/usr/bin/mysql -pHEADZZ9 db KEEP_S1_PATH",
    secrets: ["HEADZZ9"],
    preserve: ["/usr/bin/mysql", "db", "KEEP_S1_PATH"]
  },
  {
    id: "grouped-client",
    input: "(mysql -pHEADZZ9 db) KEEP_S1_GROUP",
    secrets: ["HEADZZ9"],
    preserve: ["mysql", "db", "KEEP_S1_GROUP"]
  },
  {
    id: "brace-grouped-client",
    input: "{ mysql -pHEADZZ9 db; } KEEP_S1_BRACE",
    secrets: ["HEADZZ9"],
    preserve: ["mysql", "db", "KEEP_S1_BRACE"]
  },
  {
    id: "nested-shell-client",
    input: "bash -c 'mysql -pHEADZZ9 db' KEEP_S1_NESTED",
    secrets: ["HEADZZ9"],
    preserve: ["bash", "db", "KEEP_S1_NESTED"]
  },
  {
    id: "separate-client-contexts",
    input: "mysql -pHEADZZ9 db && redis-cli -a TAILZZ9 ping KEEP_S1_CONTEXT",
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["mysql", "db", "redis-cli", "ping", "KEEP_S1_CONTEXT"]
  },
  {
    id: "credential-and-quoted-sql",
    input: "mysql -pHEADZZ9 -e 'SELECT -price FROM items' db KEEP_S1_SQL",
    secrets: ["HEADZZ9"],
    preserve: ["mysql", "SELECT", "-price", "FROM", "items", "db", "KEEP_S1_SQL"]
  },
  {
    id: "curl-then-sort-context",
    input: "curl -u user:HEADZZ9 https://example.test/; sort -u source:dest KEEP_S1_SORT",
    secrets: ["HEADZZ9"],
    preserve: ["curl", "https://example.test/", "sort -u source:dest", "KEEP_S1_SORT"]
  }
];

// Braces are literal/glued parts of a shell credential word, including when
// they do not form a balanced parameter expansion.
for (const [client, prefix] of [
  ["mysql", "mysql -p"],
  ["redis", "redis-cli -a "],
  ["curl", "curl -u user:"]
]) {
  for (const [kind, value] of [
    ["literal-opening", "HEADZZ9{TAILZZ9"],
    ["literal-closing", "HEADZZ9}TAILZZ9"],
    ["parameter", "HEADZZ9${VAR}TAILZZ9"]
  ])
    REGRESSION_CASES.push({
      id: `${client}-${kind}-brace`,
      input: `${prefix}${value} KEEP_S1_BRACE`,
      secrets: ["HEADZZ9", "TAILZZ9"],
      preserve: ["KEEP_S1_BRACE"]
    });
}
REGRESSION_CASES.push(
  {
    id: "multiline-html-passphrase-attribute",
    input: '<input value="HEADZZ9"\n type="password" data-passphrase="PUBLICZZ9"> KEEP_S1_HTML',
    secrets: ["HEADZZ9"],
    preserve: ["KEEP_S1_HTML"]
  },
  {
    id: "multiline-html-self-close",
    input: '<input value="HEADZZ9"\n type="password" data-passphrase="PUBLICZZ9"/> KEEP_S1_HTML',
    secrets: ["HEADZZ9"],
    preserve: ["KEEP_S1_HTML"]
  },
  {
    id: "env-glued-comma",
    input: 'PASSWORD="HEADZZ9",TAILZZ9 KEEP_S1_ENV',
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["KEEP_S1_ENV"]
  },
  {
    id: "env-glued-brace",
    input: 'PASSWORD="HEADZZ9"}TAILZZ9 KEEP_S1_ENV',
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["KEEP_S1_ENV"]
  },
  {
    id: "html-later-passphrase",
    input: '<input value="HEADZZ9" type="password" data-passphrase="PUBLICZZ9"> KEEP_S1_HTML',
    secrets: ["HEADZZ9"],
    preserve: ["KEEP_S1_HTML"]
  }
);

// Measured on both complete masks at immutable 6fb1a228a0bb66a41c8241517013c8a53556ef21:
// every declared secret word below was already readable. These noncanonical
// JSON argv/escaped-JSON and unclosed-input-attribute shapes have no masking
// guarantee in S1. Keep public controls; improvements may mask any of the words.
const LEGACY_RESIDUE_CASES: Case[] = [
  {
    id: "unclosed-html-input-attribute",
    input: '<input type="password" value="HEADZZ9 TAILZZ9> KEEP_S1_INPUT',
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["KEEP_S1_INPUT"]
  },
  {
    id: "json-client-escaped-credential",
    input: '{"command": "mysql -p\\"HEADZZ9 TAILZZ9\\" db"} KEEP_S1_JSON',
    secrets: ["HEADZZ9", "TAILZZ9"],
    preserve: ["KEEP_S1_JSON"]
  },
  {
    id: "json-client-array",
    input: '["mysql", "-pHEADZZ9", "db"] KEEP_S1_ARRAY',
    secrets: ["HEADZZ9"],
    preserve: ["KEEP_S1_ARRAY"]
  },
  {
    id: "json-redis-array",
    input: '["redis-cli", "-a", "HEADZZ9", "ping"] KEEP_S1_REDIS_ARRAY',
    secrets: ["HEADZZ9"],
    preserve: ["KEEP_S1_REDIS_ARRAY"]
  }
];

const corpus = readFileSync(join(ROOT, "tests/fixtures/redaction-corpus/corpus.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Case);
const issueCases = corpus.filter((c) => /^(G-230-|G-234-|K-|M-|O-|S1-)/.test(c.id));
const masks = COPIES.map(extracted);

it("rejects a failed masking stage instead of treating its empty output as a pass", () => {
  expect(run("mask() { cat; }", "KEEP_S1_READER")).toBe("KEEP_S1_READER");
  expect(() => run("mask() { false | cat; }", "KEEP_S1_READER")).toThrow();
});

it("binds both complete hook mask functions to the same sha256", () => {
  const hashes = masks.map((source) => createHash("sha256").update(source).digest("hex"));
  expect(hashes).toHaveLength(2);
  expect(hashes[0]).toBe(hashes[1]);
  expect(masks[0]).toBe(masks[1]);
});

for (const [index, file] of COPIES.entries()) {
  const source = masks[index]!;
  describe(`S1 original-input ranges: ${file}`, () => {
    it.each(issueCases)("$id hides every declared secret", ({ input, secrets }) => {
      expect(readable(run(source, input), secrets)).toEqual([]);
    });

    it.each(REGRESSION_CASES)(
      "$id hides original secret words and preserves its public controls",
      ({ input, secrets, preserve }) => {
        for (const word of [...secrets, ...preserve]) expect(input).toContain(word);
        const output = run(source, input);
        expect(readable(output, secrets)).toEqual([]);
        expect(broken(input, output, preserve)).toEqual([]);
      }
    );

    it.each(LEGACY_RESIDUE_CASES)(
      "$id keeps public controls; secret coverage remains a legacy residue",
      ({ input, secrets, preserve }) => {
        for (const word of [...secrets, ...preserve]) expect(input).toContain(word);
        expect(broken(input, run(source, input), preserve)).toEqual([]);
      }
    );

    it("preserves ordinary commands, quoted SQL arguments and normal newlines", () => {
      for (const input of [
        "sort -u source:dest file.txt",
        "echo 'mysql -p is documentation'",
        "mysql -u root -h db -e 'SELECT -price FROM items'",
        "mysql -e 'SELECT -price FROM items'; sort -u source:dest KEEP_S1_SQL_CONTROL",
        "echo mysql; printf -pPUBLIC_S1_WORD",
        "echo first\necho second\n",
        "mysql -h db\n-pPUBLIC_S1_WORD",
        "redis-cli -h db\n-a PUBLIC_S1_WORD"
      ])
        expect(run(source, input)).toBe(input);
    });

    it("does not cap client argument distance or accept a mask-shaped secret prefix", () => {
      const input = `mysql ${"--verbose ".repeat(40)}-p***MASKEDP***S1TAIL -pS1SECOND`;
      const output = run(source, input);
      expect(output).not.toContain("S1TAIL");
      expect(output).not.toContain("S1SECOND");
      expect(output).not.toContain("***MASKEDP***");
    });

    it("does not cap closed quoted values at the BSD repetition limit", () => {
      for (const quote of ["'", '"']) {
        const input = `gpg --passphrase ${quote}${"piece\\x ".repeat(600)}S1LONGTAIL${quote} KEEP_S1_END`;
        const output = run(source, input);
        expect(output).not.toContain("piece");
        expect(output).not.toContain("S1LONGTAIL");
        expect(output).toContain("KEEP_S1_END");
      }
    });

    it("loses continued mysql and redis coverage when continuation context is reset", () => {
      const mutant = changed(source, "if (!s1_continued)", "if (1)");
      for (const input of ["mysql \\\n -pS1CONTINUED", "redis-cli \\\n -a S1CONTINUED"]) {
        expect(run(source, input)).not.toContain("S1CONTINUED");
        expect(run(mutant, input)).toContain("S1CONTINUED");
      }
    });

    it("loses each credential-client family when its original-token guard is removed", () => {
      for (const [guard, input] of [
        ['s1_clients[level, "curl"] && (word == "-u"', 'curl -u "user:S1FIRST S1SECOND" KEEP_S1_END'],
        ['s1_clients[level, "mysql"] && word ~ /^-p./', "mysql -p'S1FIRST S1SECOND'"],
        ['s1_clients[level, "redis-cli"] && (word == "-a"', "redis-cli -a 'S1FIRST S1SECOND'"]
      ]) {
        const mutant = changed(source, guard!, `0 && ${guard}`);
        expect(run(source, input!)).not.toContain("S1FIRST");
        expect(run(mutant, input!)).toContain("S1FIRST");
      }
    });

    it("loses the YAML tail when the original quoted-range guard is removed", () => {
      const input = "password: 'S1HEAD''S1TAIL with S1LAST',token: S1NEXT";
      const mutant = changed(source, "        if (last) {", "        if (0) {");
      expect(readable(run(source, input), ["S1HEAD", "S1TAIL", "S1LAST", "S1NEXT"])).toEqual([]);
      expect(run(mutant, input)).toContain("S1LAST");
    });

    it("retains later keyword values under both the original collector and quote-aware compatibility fallback", () => {
      const compatibility = changed(source, "      s1_collect()", '      printf "%s", $0');
      for (const input of [
        "{password: 'S1A''S1B\\ S1C',token: S1NEXT}",
        "{password: 'S1A''S1B\\-----S1C',token: S1NEXT}"
      ]) {
        const secrets = ["S1A", "S1B", "S1C", "S1NEXT"];
        expect(readable(run(source, input), secrets)).toEqual([]);
        expect(readable(run(compatibility, input), secrets)).toEqual([]);
      }
    });

    it("exposes the keyword-suffix passphrase when original-input collection is bypassed", () => {
      const input = 'gpg --passphrase "monkey S1SECOND" KEEP_S1_END';
      const mutant = changed(source, "      s1_collect()", '      printf "%s", $0');
      expect(readable(run(source, input), ["monkey", "S1SECOND"])).toEqual([]);
      expect(readable(run(mutant, input), ["monkey", "S1SECOND"])).toContain("monkey");
    });

    it("exposes the glued suffix when the original quoted range stops at the first closing quote", () => {
      const input = 'PASSWORD="HEADZZ9"TAILZZ9 KEEP_S1_ENV';
      const mutant = changed(
        source,
        "if (!in_tag && s1_words[j] > last &&",
        "if (0 && !in_tag && s1_words[j] > last &&"
      );
      expect(readable(run(source, input), ["HEADZZ9", "TAILZZ9"])).toEqual([]);
      expect(readable(run(mutant, input), ["HEADZZ9", "TAILZZ9"])).toContain("TAILZZ9");
    });

    it("reaches the unmatched-quote fallback after a quoted key without feeding the escaped tail to sed", () => {
      const input = '{"password":"HEADZZ9 tail';
      const mutant = changed(source, "s1_keyword(i, in_tag)", 's1_at(i, "")');
      const output = run(source, input);
      expect(output).not.toContain("HEADZZ9");
      expect(output).toContain(" tail");
      expect(run(mutant, input)).toContain("HEADZZ9");
    });

    it("preserves the URL host when original userinfo ranges suppress inner keyword collection", () => {
      const input = "https://user:password=HEADZZ9@host/path KEEP_S1_URL";
      const mutant = changed(source, "      s1_original_shapes()", '      s1_at(1, "")');
      expect(readable(run(source, input), ["HEADZZ9"])).toEqual([]);
      expect(broken(input, run(source, input), ["@host/path", "KEEP_S1_URL"])).toEqual([]);
      expect(broken(input, run(mutant, input), ["@host/path"])).toEqual(["@host/path"]);
    });
  });
}
