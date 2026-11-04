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
const checkout = execFileSyncBounded("git", ["rev-parse", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 3000
}).trim();

function extracted(file: string): string {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const start = lines.indexOf("mask() {");
  const end = lines.findIndex((line, i) => i > start && line === "}");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end + 1).join("\n");
}
const masks = COPIES.map(extracted);
const sourceHashes = masks.map((source) => createHash("sha256").update(source).digest("hex"));
function emit(record: string) {
  process.stdout.write(record + "\n");
}
function changed(source: string, before: string, after: string): string {
  expect(source.split(before), `unique mutation target: ${before}`).toHaveLength(2);
  return source.replace(before, after);
}
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
function timed(file: string, name: string, check: () => void) {
  it(
    name,
    () => {
      const startedAt = new Date().toISOString();
      const tick = performance.now();
      let outcome = "failed";
      try {
        check();
        outcome = "passed";
      } finally {
        emit(
          JSON.stringify({
            measurement: "S1-SCAN-TEST",
            file,
            name,
            startedAt,
            finishedAt: new Date().toISOString(),
            elapsedMs: performance.now() - tick,
            outcome,
            checkout,
            runtime: { node: process.version, platform: process.platform, arch: process.arch },
            sourceHashes,
            scope: "callback assertions; final Vitest/CI status is checked separately"
          })
        );
      }
    },
    120_000
  );
}
type Case = { id: string; family: string; input: string; secrets: string[]; preserve: string[]; exact?: string };
const CASES: Case[] = [
  {
    id: "F1-multiline-curl",
    family: "F1-multiline",
    input: "result=$(curl -u user:SYN_F1_multiline_CURL_9 https://example.invalid/ KEEP_CURL\n)\necho KEEP_F1_END",
    secrets: ["SYN_F1_multiline_CURL_9"],
    preserve: ["KEEP_F1_END", "KEEP_CURL"]
  },
  {
    id: "F1-single-quoted-curl",
    family: "F1-single-quoted",
    input: "echo '$(curl -u user:SYN_F1_single_quoted_CURL_9 https://example.invalid/ KEEP_CURL)' KEEP_F1_END",
    secrets: ["SYN_F1_single_quoted_CURL_9"],
    preserve: ["KEEP_F1_END", "KEEP_CURL"]
  },
  {
    id: "F2-newline-curl",
    family: "F2-json",
    input: '{"command":"echo KEEP_PRE\\ncurl -u user:SYN_F2_NEWLINE_CURL_9 https://example.invalid/ KEEP_CURL"}',
    secrets: ["SYN_F2_NEWLINE_CURL_9"],
    preserve: ["KEEP_PRE", "KEEP_CURL"]
  },
  {
    id: "F2-tab-curl",
    family: "F2-json",
    input: '{"command":"echo KEEP_PRE\\tcurl -u user:SYN_F2_TAB_CURL_9 https://example.invalid/ KEEP_CURL"}',
    secrets: ["SYN_F2_TAB_CURL_9"],
    preserve: ["KEEP_PRE", "KEEP_CURL"]
  },
  {
    id: "F5-placeholder-curl",
    family: "F5-brace",
    input: "curl {} -u user:SYN_F5_CURL_9 https://example.invalid/ KEEP_CURL KEEP_F5_END",
    secrets: ["SYN_F5_CURL_9"],
    preserve: ["{}", "KEEP_F5_END", "KEEP_CURL"]
  },
  {
    id: "F1-multiline-mysql",
    family: "F1-multiline",
    input: "result=$(mysql -pSYN_F1_multiline_MYSQL_9 db KEEP_MYSQL\n)\necho KEEP_F1_END",
    secrets: ["SYN_F1_multiline_MYSQL_9"],
    preserve: ["KEEP_F1_END", "KEEP_MYSQL"]
  },
  {
    id: "F1-single-quoted-mysql",
    family: "F1-single-quoted",
    input: "echo '$(mysql -pSYN_F1_single_quoted_MYSQL_9 db KEEP_MYSQL)' KEEP_F1_END",
    secrets: ["SYN_F1_single_quoted_MYSQL_9"],
    preserve: ["KEEP_F1_END", "KEEP_MYSQL"]
  },
  {
    id: "F2-newline-mysql",
    family: "F2-json",
    input: '{"command":"echo KEEP_PRE\\nmysql -pSYN_F2_NEWLINE_MYSQL_9 db KEEP_MYSQL"}',
    secrets: ["SYN_F2_NEWLINE_MYSQL_9"],
    preserve: ["KEEP_PRE", "KEEP_MYSQL"]
  },
  {
    id: "F2-tab-mysql",
    family: "F2-json",
    input: '{"command":"echo KEEP_PRE\\tmysql -pSYN_F2_TAB_MYSQL_9 db KEEP_MYSQL"}',
    secrets: ["SYN_F2_TAB_MYSQL_9"],
    preserve: ["KEEP_PRE", "KEEP_MYSQL"]
  },
  {
    id: "F5-placeholder-mysql",
    family: "F5-brace",
    input: "mysql {} -pSYN_F5_MYSQL_9 db KEEP_MYSQL KEEP_F5_END",
    secrets: ["SYN_F5_MYSQL_9"],
    preserve: ["{}", "KEEP_F5_END", "KEEP_MYSQL"]
  },
  {
    id: "F1-multiline-redis",
    family: "F1-multiline",
    input: "result=$(redis-cli -a SYN_F1_multiline_REDIS_9 ping KEEP_REDIS\n)\necho KEEP_F1_END",
    secrets: ["SYN_F1_multiline_REDIS_9"],
    preserve: ["KEEP_F1_END", "KEEP_REDIS"]
  },
  {
    id: "F1-single-quoted-redis",
    family: "F1-single-quoted",
    input: "echo '$(redis-cli -a SYN_F1_single_quoted_REDIS_9 ping KEEP_REDIS)' KEEP_F1_END",
    secrets: ["SYN_F1_single_quoted_REDIS_9"],
    preserve: ["KEEP_F1_END", "KEEP_REDIS"]
  },
  {
    id: "F2-newline-redis",
    family: "F2-json",
    input: '{"command":"echo KEEP_PRE\\nredis-cli -a SYN_F2_NEWLINE_REDIS_9 ping KEEP_REDIS"}',
    secrets: ["SYN_F2_NEWLINE_REDIS_9"],
    preserve: ["KEEP_PRE", "KEEP_REDIS"]
  },
  {
    id: "F2-tab-redis",
    family: "F2-json",
    input: '{"command":"echo KEEP_PRE\\tredis-cli -a SYN_F2_TAB_REDIS_9 ping KEEP_REDIS"}',
    secrets: ["SYN_F2_TAB_REDIS_9"],
    preserve: ["KEEP_PRE", "KEEP_REDIS"]
  },
  {
    id: "F5-placeholder-redis",
    family: "F5-brace",
    input: "redis-cli {} -a SYN_F5_REDIS_9 ping KEEP_REDIS KEEP_F5_END",
    secrets: ["SYN_F5_REDIS_9"],
    preserve: ["{}", "KEEP_F5_END", "KEEP_REDIS"]
  },
  {
    id: "public-0",
    family: "public",
    input: "sort -u source:dest file.txt",
    secrets: [],
    preserve: ["sort -u source:dest file.txt"],
    exact: "sort -u source:dest file.txt"
  },
  {
    id: "public-1",
    family: "public",
    input: "git push -u origin branch",
    secrets: [],
    preserve: ["git push -u origin branch"],
    exact: "git push -u origin branch"
  },
  {
    id: "public-2",
    family: "public",
    input: "mkdir -p /tmp/a && cp -pR src dst && ssh -p2222 host",
    secrets: [],
    preserve: ["mkdir -p /tmp/a && cp -pR src dst && ssh -p2222 host"],
    exact: "mkdir -p /tmp/a && cp -pR src dst && ssh -p2222 host"
  },
  {
    id: "public-3",
    family: "public",
    input: "mysql -e 'SELECT -price FROM items' db",
    secrets: [],
    preserve: ["mysql -e 'SELECT -price FROM items' db"],
    exact: "mysql -e 'SELECT -price FROM items' db"
  },
  {
    id: "public-4",
    family: "public",
    input: "echo {KEEP} plain",
    secrets: [],
    preserve: ["echo {KEEP} plain"],
    exact: "echo {KEEP} plain"
  },
  {
    id: "public-5",
    family: "public",
    input: "echo ${KEEP_PUBLIC} plain",
    secrets: [],
    preserve: ["echo ${KEEP_PUBLIC} plain"],
    exact: "echo ${KEEP_PUBLIC} plain"
  },
  {
    id: "public-6",
    family: "public",
    input: '{"command":"sort -u source:dest\\necho KEEP_JSON"}',
    secrets: [],
    preserve: ['{"command":"sort -u source:dest\\necho KEEP_JSON"}'],
    exact: '{"command":"sort -u source:dest\\necho KEEP_JSON"}'
  },
  {
    id: "F1-double-quoted-multiline-curl",
    family: "F1-multiline",
    input: 'echo "$(curl -u user:SYN_F1_DQ_CURL_9 https://example.invalid/ KEEP_CURL\n)" KEEP_F1_DQ',
    secrets: ["SYN_F1_DQ_CURL_9"],
    preserve: ["KEEP_F1_DQ", "KEEP_CURL"]
  },
  {
    id: "F5-xargs-curl",
    family: "F5-brace",
    input: "printf KEEP_PATH | xargs -I{} curl {} -u user:SYN_F5_XARGS_CURL_9 https://example.invalid/ KEEP_CURL",
    secrets: ["SYN_F5_XARGS_CURL_9"],
    preserve: ["KEEP_PATH", "{}", "KEEP_CURL"]
  },
  {
    id: "F2-tight-client-tab-curl",
    family: "F2-json",
    input: '{"command":"echo KEEP_PRE\\ncurl\\t-u user:SYN_F2_TIGHT_CURL_9 https://example.invalid/ KEEP_CURL"}',
    secrets: ["SYN_F2_TIGHT_CURL_9"],
    preserve: ["KEEP_PRE", "KEEP_CURL"]
  },
  {
    id: "F1-double-quoted-multiline-mysql",
    family: "F1-multiline",
    input: 'echo "$(mysql -pSYN_F1_DQ_MYSQL_9 db KEEP_MYSQL\n)" KEEP_F1_DQ',
    secrets: ["SYN_F1_DQ_MYSQL_9"],
    preserve: ["KEEP_F1_DQ", "KEEP_MYSQL"]
  },
  {
    id: "F5-xargs-mysql",
    family: "F5-brace",
    input: "printf KEEP_PATH | xargs -I{} mysql {} -pSYN_F5_XARGS_MYSQL_9 db KEEP_MYSQL",
    secrets: ["SYN_F5_XARGS_MYSQL_9"],
    preserve: ["KEEP_PATH", "{}", "KEEP_MYSQL"]
  },
  {
    id: "F2-tight-client-tab-mysql",
    family: "F2-json",
    input: '{"command":"echo KEEP_PRE\\nmysql\\t-pSYN_F2_TIGHT_MYSQL_9 db KEEP_MYSQL"}',
    secrets: ["SYN_F2_TIGHT_MYSQL_9"],
    preserve: ["KEEP_PRE", "KEEP_MYSQL"]
  },
  {
    id: "F1-double-quoted-multiline-redis",
    family: "F1-multiline",
    input: 'echo "$(redis-cli -a SYN_F1_DQ_REDIS_9 ping KEEP_REDIS\n)" KEEP_F1_DQ',
    secrets: ["SYN_F1_DQ_REDIS_9"],
    preserve: ["KEEP_F1_DQ", "KEEP_REDIS"]
  },
  {
    id: "F5-xargs-redis",
    family: "F5-brace",
    input: "printf KEEP_PATH | xargs -I{} redis-cli {} -a SYN_F5_XARGS_REDIS_9 ping KEEP_REDIS",
    secrets: ["SYN_F5_XARGS_REDIS_9"],
    preserve: ["KEEP_PATH", "{}", "KEEP_REDIS"]
  },
  {
    id: "F2-tight-client-tab-redis",
    family: "F2-json",
    input: '{"command":"echo KEEP_PRE\\nredis-cli\\t-a SYN_F2_TIGHT_REDIS_9 ping KEEP_REDIS"}',
    secrets: ["SYN_F2_TIGHT_REDIS_9"],
    preserve: ["KEEP_PRE", "KEEP_REDIS"]
  },
  {
    id: "new-public-0",
    family: "public",
    input: "echo KEEP_PRE\\ncurl -u source:dest KEEP_LITERAL",
    secrets: [],
    preserve: ["echo KEEP_PRE\\ncurl -u source:dest KEEP_LITERAL"],
    exact: "echo KEEP_PRE\\ncurl -u source:dest KEEP_LITERAL"
  },
  {
    id: "new-public-1",
    family: "public",
    input: '{"command":"echo KEEP_PRE\\\\ncurl -u source:dest KEEP_LITERAL"}',
    secrets: [],
    preserve: ['{"command":"echo KEEP_PRE\\\\ncurl -u source:dest KEEP_LITERAL"}'],
    exact: '{"command":"echo KEEP_PRE\\\\ncurl -u source:dest KEEP_LITERAL"}'
  },
  {
    id: "new-public-2",
    family: "public",
    input: '{"command":"curl --help\\nsort -u source:dest KEEP_SORT"}',
    secrets: [],
    preserve: ['{"command":"curl --help\\nsort -u source:dest KEEP_SORT"}'],
    exact: '{"command":"curl --help\\nsort -u source:dest KEEP_SORT"}'
  },
  {
    id: "new-public-3",
    family: "public",
    input: "curl --help; { sort -u source:dest file; }",
    secrets: [],
    preserve: ["curl --help; { sort -u source:dest file; }"],
    exact: "curl --help; { sort -u source:dest file; }"
  },
  {
    id: "new-public-4",
    family: "public",
    input: "{ sort -u source:dest file; }",
    secrets: [],
    preserve: ["{ sort -u source:dest file; }"],
    exact: "{ sort -u source:dest file; }"
  },
  {
    id: "F3-image",
    family: "F3-alias",
    input: "docker run curlimages/curl:8 -u user:FSCAN_ALIAS9 https://example.invalid KEEP_F3",
    secrets: ["FSCAN_ALIAS9"],
    preserve: ["KEEP_F3", "https://example.invalid"]
  },
  {
    id: "F3-long-image",
    family: "F3-alias",
    input:
      "docker run curlimages/curl:vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv -u user:FSCAN_ALIAS9 https://example.invalid KEEP_F3",
    secrets: ["FSCAN_ALIAS9"],
    preserve: ["KEEP_F3", "https://example.invalid"]
  },
  {
    id: "F3-extension",
    family: "F3-alias",
    input: "/usr/bin/curl.exe -u user:FSCAN_ALIAS9 https://example.invalid KEEP_F3",
    secrets: ["FSCAN_ALIAS9"],
    preserve: ["KEEP_F3", "https://example.invalid"]
  },
  {
    id: "F3-quoted-extension",
    family: "F3-alias",
    input: '"curl.exe" -u user:FSCAN_ALIAS9 https://example.invalid KEEP_F3',
    secrets: ["FSCAN_ALIAS9"],
    preserve: ["KEEP_F3", "https://example.invalid"]
  },
  {
    id: "F3-variable",
    family: "F3-dynamic",
    input: '"$CURL" -u user:FSCAN_DYNAMIC9 KEEP_F3',
    secrets: ["FSCAN_DYNAMIC9"],
    preserve: ["KEEP_F3"]
  },
  {
    id: "F3-command-array",
    family: "F3-dynamic",
    input: '"${curl_cmd[@]}" -u user:FSCAN_DYNAMIC9 KEEP_F3',
    secrets: ["FSCAN_DYNAMIC9"],
    preserve: ["KEEP_F3"]
  },
  {
    id: "F3-array",
    family: "F3-array",
    input: 'opts=( -u user:FSCAN_ARRAY9 ); curl "${opts[@]}"; sort -u source:dest KEEP_F3',
    secrets: ["FSCAN_ARRAY9"],
    preserve: ["sort -u source:dest", "KEEP_F3"]
  },
  {
    id: "F3-multiline-array",
    family: "F3-array",
    input: "opts=(\n -u user:FSCAN_ARRAY9\n)\nsort -u source:dest KEEP_F3",
    secrets: ["FSCAN_ARRAY9"],
    preserve: ["sort -u source:dest", "KEEP_F3"]
  },
  {
    id: "F3-array-append",
    family: "F3-array",
    input: "opts+=( -u user:FSCAN_ARRAY9 ); sort -u source:dest KEEP_F3",
    secrets: ["FSCAN_ARRAY9"],
    preserve: ["sort -u source:dest", "KEEP_F3"]
  },
  {
    id: "F3-redis-url",
    family: "F3-url",
    input: "redis-cli -u redis://:FSCAN_URL9@host:6379/0 KEEP_F3",
    secrets: ["FSCAN_URL9"],
    preserve: ["@host:6379/0", "KEEP_F3"]
  },
  {
    id: "F3-rediss-url",
    family: "F3-url",
    input: "redis-cli -u rediss://:FSCAN_URL9@host:6379/0 KEEP_F3",
    secrets: ["FSCAN_URL9"],
    preserve: ["@host:6379/0", "KEEP_F3"]
  },
  {
    id: "F3-crlf-curl",
    family: "F3-crlf",
    input: "curl \\\r\n -u user:FSCAN_CRLF9 KEEP_F3",
    secrets: ["FSCAN_CRLF9"],
    preserve: ["KEEP_F3"]
  },
  {
    id: "F3-crlf-mysql",
    family: "F3-crlf",
    input: "mysql \\\r\n -pFSCAN_CRLF9 KEEP_F3",
    secrets: ["FSCAN_CRLF9"],
    preserve: ["KEEP_F3"]
  },
  {
    id: "F3-crlf-redis",
    family: "F3-crlf",
    input: "redis-cli \\\r\n -a FSCAN_CRLF9 KEEP_F3",
    secrets: ["FSCAN_CRLF9"],
    preserve: ["KEEP_F3"]
  },
  {
    id: "F4-empty",
    family: "F4-functional",
    input: "curl --user= KEEP_F4",
    secrets: [],
    preserve: ["KEEP_F4"]
  },
  {
    id: "F4-stale-unrelated",
    family: "F4-functional",
    input: "curl --output=public:KEEP_FILE --user= KEEP_AFTER",
    secrets: [],
    preserve: ["KEEP_FILE", "KEEP_AFTER"]
  },
  {
    id: "F4-stale-user",
    family: "F4-functional",
    input: "curl --user=public:HEAD_F4 --user= KEEP_AFTER",
    secrets: ["HEAD_F4"],
    preserve: ["KEEP_AFTER"]
  },
  {
    id: "F4-empty-double",
    family: "F4-functional",
    input: 'curl --output=public:KEEP_FILE --user="" KEEP_AFTER',
    secrets: [],
    preserve: ["KEEP_FILE", "KEEP_AFTER"]
  },
  {
    id: "F4-empty-single",
    family: "F4-functional",
    input: "curl --output=public:KEEP_FILE --user='' KEEP_AFTER",
    secrets: [],
    preserve: ["KEEP_FILE", "KEEP_AFTER"]
  },
  {
    id: "F4-quoted-flag",
    family: "F4-functional",
    input: "curl '--user=' KEEP_F4",
    secrets: [],
    preserve: ["KEEP_F4"]
  },
  {
    id: "F4-escaped-flag",
    family: "F4-functional",
    input: "curl --us\\er= KEEP_F4",
    secrets: [],
    preserve: ["KEEP_F4"]
  },
  {
    id: "F4-joined-flag",
    family: "F4-functional",
    input: 'curl --us"er"= KEEP_F4',
    secrets: [],
    preserve: ["KEEP_F4"]
  },
  {
    id: "F4-attached",
    family: "F4-functional",
    input: "curl --user=public:HEAD_F4 https://example.invalid KEEP_F4",
    secrets: ["HEAD_F4"],
    preserve: ["KEEP_F4", "https://example.invalid"]
  },
  {
    id: "F4-attached-double",
    family: "F4-functional",
    input: 'curl --user="public:HEAD_F4" https://example.invalid KEEP_F4',
    secrets: ["HEAD_F4"],
    preserve: ["KEEP_F4", "https://example.invalid"]
  },
  {
    id: "F4-attached-single",
    family: "F4-functional",
    input: "curl --user='public:HEAD_F4' https://example.invalid KEEP_F4",
    secrets: ["HEAD_F4"],
    preserve: ["KEEP_F4", "https://example.invalid"]
  },
  {
    id: "F4-attached-quoted-flag",
    family: "F4-functional",
    input: 'curl "--user=public:HEAD_F4" https://example.invalid KEEP_F4',
    secrets: ["HEAD_F4"],
    preserve: ["KEEP_F4", "https://example.invalid"]
  },
  {
    id: "F4-attached-escaped-equals",
    family: "F4-functional",
    input: "curl --user\\=public:HEAD_F4 https://example.invalid KEEP_F4",
    secrets: ["HEAD_F4"],
    preserve: ["KEEP_F4", "https://example.invalid"]
  },
  {
    id: "F4-attached-joined-equals",
    family: "F4-functional",
    input: 'curl --user"="public:HEAD_F4 https://example.invalid KEEP_F4',
    secrets: ["HEAD_F4"],
    preserve: ["KEEP_F4", "https://example.invalid"]
  },
  {
    id: "F6-quote-glue",
    family: "F6-tag",
    input: '<x token=public"FSCAN_TAG9"> KEEP_F6',
    secrets: ["FSCAN_TAG9"],
    preserve: ["KEEP_F6", ">"]
  },
  {
    id: "F6-single-glue",
    family: "F6-tag",
    input: "<x token=public'FSCAN_TAG9'> KEEP_F6",
    secrets: ["FSCAN_TAG9"],
    preserve: ["KEEP_F6", ">"]
  },
  {
    id: "F6-password-type",
    family: "F6-control",
    input: '<input type=password value="FSCAN_TAG9"> KEEP_F6',
    secrets: ["FSCAN_TAG9"],
    preserve: ["KEEP_F6"]
  },
  {
    id: "F6-password-type-single",
    family: "F6-control",
    input: "<input type=password value='FSCAN_TAG9'> KEEP_F6",
    secrets: ["FSCAN_TAG9"],
    preserve: ["KEEP_F6"]
  },
  {
    id: "F6-quoted-spaces",
    family: "F6-control",
    input: '<input type=password value="FSCAN_TAG9 FSCAN_TAGSECOND9"> KEEP_F6',
    secrets: ["FSCAN_TAG9", "FSCAN_TAGSECOND9"],
    preserve: ["KEEP_F6"]
  },
  {
    id: "F6-unclosed-quote",
    family: "F6-tag",
    input: '<x token=public"FSCAN_TAG9> KEEP_F6',
    secrets: ["FSCAN_TAG9"],
    preserve: ["KEEP_F6", ">"]
  },
  {
    id: "extra-public-dynamic-argument",
    family: "public",
    input: 'sort "$ARG" -u source:dest KEEP_SORT',
    secrets: [],
    preserve: []
  },
  {
    id: "extra-public-array-context-end",
    family: "public",
    input: "opts=( -u public ); sort -u source:dest KEEP_SORT",
    secrets: [],
    preserve: []
  },
  {
    id: "extra-public-subshell-context",
    family: "public",
    input: "( sort -u source:dest ) KEEP_SORT",
    secrets: [],
    preserve: []
  },
  {
    id: "extra-public-ordinary-CRLF",
    family: "public",
    input: "curl\r\nsort -u source:dest KEEP_SORT",
    secrets: [],
    preserve: []
  },
  {
    id: "extra-public-nonsensitive-tag",
    family: "public",
    input: '<x class=public title="KEEP_TAG_VALUE"> KEEP_TAG',
    secrets: [],
    preserve: []
  },
  {
    id: "extra-public-plain-command-escape",
    family: "public",
    input: "printf \\ncurl -u source:dest KEEP_LITERAL",
    secrets: [],
    preserve: []
  },
  {
    id: "F6-glue-spaces",
    family: "F6-tag",
    input: '<x token=public"FSCAN_TAG9 FSCAN_TAGSECOND9"> KEEP_F6',
    secrets: ["FSCAN_TAG9", "FSCAN_TAGSECOND9"],
    preserve: ["KEEP_F6", ">"]
  },
  {
    id: "F3-array-quoted-close",
    family: "F3-array",
    input: 'opts=( "KEEP_ARRAY\n)"\n -u user:FSCAN_ARRAY_QUOTE9\n)\necho KEEP_END',
    secrets: ["FSCAN_ARRAY_QUOTE9"],
    preserve: ["KEEP_ARRAY", "KEEP_END"]
  },
  {
    id: "F3-array-pending-value",
    family: "F3-array",
    input: "opts=(\n -u\n user:FSCAN_ARRAY_PENDING9\n)\nsort -u source:dest KEEP_END",
    secrets: ["FSCAN_ARRAY_PENDING9"],
    preserve: ["sort -u source:dest", "KEEP_END"]
  },
  {
    id: "extra-public-array-quoted-open",
    family: "public",
    input: 'opts=( "KEEP_ARRAY\n("\n)\nsort -u source:dest KEEP_END',
    secrets: [],
    preserve: []
  },
  {
    id: "extra-public-sort-file-alias",
    family: "public",
    input: "sort /tmp/curl.exe -u source:dest KEEP_END",
    secrets: [],
    preserve: []
  },
  {
    id: "extra-public-sort-text-file-alias",
    family: "public",
    input: "sort curl.txt -u source:dest KEEP_END",
    secrets: [],
    preserve: []
  },
  {
    id: "extra-public-docker-image-context-end",
    family: "public",
    input: "docker run alpine sort curl:public -u source:dest KEEP_END",
    secrets: [],
    preserve: []
  },
  {
    id: "F6-adjacent-quote-pieces",
    family: "F6-tag",
    input: "<x token=public\"FSCAN_TAG_HEAD9\"'FSCAN_TAG_TAIL9'> KEEP_END",
    secrets: ["FSCAN_TAG_HEAD9", "FSCAN_TAG_TAIL9"],
    preserve: [">", "KEEP_END"]
  },
  {
    id: "F6-quoted-then-plain",
    family: "F6-tag",
    input: '<x token=public"FSCAN_TAG_HEAD9"FSCAN_TAG_TAIL9> KEEP_END',
    secrets: ["FSCAN_TAG_HEAD9", "FSCAN_TAG_TAIL9"],
    preserve: [">", "KEEP_END"]
  },
  {
    id: "F3-container-option-operands",
    family: "F3-alias",
    input: "docker run --rm --name box -u 1000:1000 -v /tmp/curl.exe curlimages/curl:8 -u user:FSCAN_ALIAS9 KEEP_F3",
    secrets: ["FSCAN_ALIAS9"],
    preserve: ["1000:1000", "/tmp/curl.exe", "KEEP_F3"]
  },
  {
    id: "extra-public-docker-option-alias",
    family: "public",
    input: "docker run --name curl:public -u source:dest alpine sort -u source:dest KEEP_END",
    secrets: [],
    preserve: []
  }
];

function requireHidden(output: string, c: Case) {
  expect(readable(output, c.secrets), `${c.id}: original credential guard`).toEqual([]);
  expect(broken(c.input, output, c.preserve), `${c.id}: public controls`).toEqual([]);
}
function nonBashInput(): Case {
  const script = readFileSync(join(ROOT, COPIES[1]!), "utf8").split("\n");
  const part = (anchor: string) => {
    const start = script.indexOf(anchor);
    const end = script.findIndex((line, i) => i > start && line === "'");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return script.slice(start + 1, end).join("\n");
  };
  const program = part("fence_jq='") + "\n" + part('body_jq="$fence_jq"\'');
  const command =
    "echo KEEP_ROUTE\ncurl -u user:FSCAN_ROUTE_CURL9 https://example.invalid/\nmysql -pFSCAN_ROUTE_MYSQL9 db\nredis-cli -a FSCAN_ROUTE_REDIS9 ping KEEP_ROUTE_END";
  const transcript = [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "SyntheticTool", input: { command } }] } }
  ];
  const input = execFileSyncBounded("jq", ["-r", program], {
    input: JSON.stringify(transcript),
    encoding: "utf8",
    timeout: 4000,
    maxBuffer: 64 * 1024
  });
  expect(input).toContain("\\ncurl");
  return {
    id: "F2-actual-non-Bash-renderer",
    family: "F2-renderer",
    input,
    secrets: ["FSCAN_ROUTE_CURL9", "FSCAN_ROUTE_MYSQL9", "FSCAN_ROUTE_REDIS9"],
    preserve: ["SyntheticTool", "KEEP_ROUTE", "KEEP_ROUTE_END"]
  };
}
function reverseCases(source: string, cases: Case[], before: string, after: string) {
  expect(cases.length).toBeGreaterThan(0);
  for (const c of cases) requireHidden(run(source, c.input), c);
  const mutant = changed(source, before, after);
  for (const c of cases) {
    const output = run(mutant, c.input);
    expect(readable(output, c.secrets), `${c.id}: mutation reaches actual canary`).toEqual(c.secrets);
    expect(broken(c.input, output, c.preserve), c.id).toEqual([]);
    expect(() => requireHidden(output, c)).toThrow(`${c.id}: original credential guard`);
  }
}

function boundsTrace(source: string) {
  const boundary = "\n  ' |\n  sed -E \\\n";
  expect(source.split(boundary)).toHaveLength(2);
  let collector = source.slice(0, source.indexOf(boundary)) + "\n  '\n}";
  collector = changed(
    collector,
    '        colon = start\n        while (colon <= last && original_bytes[colon] != ":") colon++',
    "        s1_f4_flags++\n        if (start < first || start > last + 1) s1_f4_bad_start++\n        colon = start\n        while (colon <= last && s1_f4_not_colon(colon, first, last)) colon++"
  );
  collector = changed(
    collector,
    "| LC_ALL=C awk '\n",
    `| LC_ALL=C awk '
    function s1_f4_not_colon(at, first, last) {
      s1_f4_tests++
      if (at < first || at > last) s1_f4_outside++
      return original_bytes[at] != ":"
    }
    END { printf "F4_OPS:%d:%d:%d:%d:%d\\n", NR, s1_f4_flags + 0, s1_f4_tests + 0, s1_f4_outside + 0, s1_f4_bad_start + 0 }
`
  );
  const input = "curl " + "--user= ".repeat(8) + "KEEP_F4";
  const output = run(collector, input);
  const trace = [...output.matchAll(/^F4_OPS:(\d+):(\d+):(\d+):(\d+):(\d+)\n/gm)];
  expect(trace).toHaveLength(1);
  expect(output.replace(trace[0]![0], "")).toBe(`F0\nN${input}\n`);
  return {
    records: Number(trace[0]![1]),
    flags: Number(trace[0]![2]),
    tests: Number(trace[0]![3]),
    outside: Number(trace[0]![4]),
    badStarts: Number(trace[0]![5])
  };
}
function requireBounds(trace: ReturnType<typeof boundsTrace>) {
  expect(trace.records).toBe(1);
  expect(trace.flags).toBe(8);
  expect([trace.outside, trace.badStarts], "F4 colon scan must stay within its own word").toEqual([0, 0]);
}
function workTrace(source: string, input: string, kind: "carry" | "tag") {
  const boundary = "\n  ' |\n  sed -E \\\n";
  expect(source.split(boundary)).toHaveLength(2);
  let collector = source.slice(0, source.indexOf(boundary)) + "\n  '\n}";
  if (kind === "carry") {
    expect(collector).toContain("s1_stack[++top] =");
    collector = collector.replaceAll("s1_stack[++top] =", "s1_test_work++; s1_stack[++top] =");
  } else {
    collector = changed(
      collector,
      '      while (j <= n) {\n        if (original_bytes[j] == ">") break',
      '      while (j <= n) {\n        s1_test_work++\n        if (original_bytes[j] == ">") break'
    );
    collector = changed(
      collector,
      "    function s1_tag_end(at,    j, qend) {",
      "    function s1_tag_end(at,    j, qend) {\n      s1_test_calls++"
    );
  }
  collector = changed(
    collector,
    "| LC_ALL=C awk '\n",
    `| LC_ALL=C awk '
    END { printf "S1_WORK:%d:%d:%d\\n", NR, s1_test_work + 0, s1_test_calls + 0 }
`
  );
  const raw = run(collector, input);
  const trace = [...raw.matchAll(/^S1_WORK:(\d+):(\d+):(\d+)\n/gm)];
  expect(trace).toHaveLength(1);
  return {
    records: Number(trace[0]![1]),
    work: Number(trace[0]![2]),
    calls: Number(trace[0]![3]),
    output: raw.replace(trace[0]![0], "")
  };
}

for (const [index, file] of COPIES.entries()) {
  const source = masks[index]!;
  describe(`S1 scan findings: ${file}`, () => {
    timed(file, "F1 scans unmapped multiline and single-quoted substitutions for all three clients", () => {
      reverseCases(
        source,
        CASES.filter((c) => c.id.startsWith("F1-")),
        "else if (!qend && (s1_unclosed_parens[j + 1] || s1_literal_substitution[j + 1]) && j + 2 <= end)",
        "else if (0 && !qend && (s1_unclosed_parens[j + 1] || s1_literal_substitution[j + 1]) && j + 2 <= end)"
      );
    });
    timed(file, "F2 separates serialized non-Bash JSON whitespace without joining client names", () => {
      reverseCases(
        source,
        CASES.filter((c) => c.id.startsWith("F2-")),
        "return s1_json_record &&",
        "return 0 && s1_json_record &&"
      );
    });
    timed(file, "F2 covers the shipped non-Bash tool renderer through the masking stage", () => {
      reverseCases(source, [nonBashInput()], "return s1_json_record &&", "return 0 && s1_json_record &&");
    });
    timed(file, "F3 recognizes curl image tags and executable extensions", () => {
      reverseCases(
        source,
        CASES.filter((c) => c.family === "F3-alias"),
        "alias && (s1_command_start[level] || (alias == 2 && s1_container[level] == 2))",
        "0 && alias && (s1_command_start[level] || (alias == 2 && s1_container[level] == 2))"
      );
    });
    timed(file, "F3 scopes expanded credential clients to command position", () => {
      reverseCases(
        source,
        CASES.filter((c) => c.family === "F3-dynamic"),
        'if (s1_command_start[level] && original_bytes[j] == "$"',
        'if (0 && s1_command_start[level] && original_bytes[j] == "$"'
      );
    });
    timed(file, "F3 confines option-array credentials to their own array body", () => {
      reverseCases(
        source,
        CASES.filter((c) => c.family === "F3-array"),
        'if (s1_command_start[level] && original_bytes[end + 1] == "(" && s1_option_array(i, end))',
        'if (0 && s1_command_start[level] && original_bytes[end + 1] == "(" && s1_option_array(i, end))'
      );
    });
    timed(file, "F3 carries historical array depth without rebuilding old stack entries", () => {
      const input = ["opts=" + "(".repeat(8), ...Array<string>(16).fill("x")].join("\n");
      const expected = input
        .split("\n")
        .map((line) => `F0\nN${line}\n`)
        .join("");
      const original = workTrace(source, input, "carry");
      expect(original.records).toBe(17);
      expect(original.work).toBe(8);
      expect(original.output).toBe(expected);
      let mutant = changed(
        source,
        "if (array_record) group_quote = s1_array_quote",
        "if (array_record) { group_quote = s1_array_quote; for (i = 1; i <= array_record; i++) { s1_stack[++top] = 1 - i } }"
      );
      mutant = changed(
        mutant,
        "if (array_record && s1_array_depth) s1_array_depth += top",
        "if (array_record && s1_array_depth) s1_array_depth = top"
      );
      const changedTrace = workTrace(mutant, input, "carry");
      expect(changedTrace.records).toBe(17);
      expect(changedTrace.output).toBe(expected);
      const requireLinear = (work: number) =>
        expect(work, "F3 historical depth must stay scalar").toBeLessThanOrEqual(Buffer.byteLength(input));
      requireLinear(original.work);
      expect(changedTrace.work).toBeGreaterThan(Buffer.byteLength(input));
      expect(() => requireLinear(changedTrace.work)).toThrow("F3 historical depth must stay scalar");
    });
    timed(file, "F3 ends carried option arrays at structural fence boundaries", () => {
      const c: Case = {
        id: "F3-array-fence-boundary",
        family: "F3-control",
        input: "~~~~~~bash\nopts=( -u user:FSCAN_BOUNDARY9\n~~~~~~\nsort -u source:dest KEEP_BOUNDARY",
        secrets: ["FSCAN_BOUNDARY9"],
        preserve: ["sort -u source:dest", "KEEP_BOUNDARY"]
      };
      requireHidden(run(source, c.input), c);
      const mutant = changed(
        source,
        "if (any_fence && (array_record || s1_array_depth))",
        "if (0 && any_fence && (array_record || s1_array_depth))"
      );
      const output = run(mutant, c.input);
      expect(readable(output, c.secrets)).toEqual([]);
      expect(broken(c.input, output, c.preserve)).toEqual(["sort -u source:dest"]);
      expect(() => requireHidden(output, c)).toThrow("F3-array-fence-boundary: public controls");
    });
    timed(file, "F3 masks redis URL credentials with empty usernames", () => {
      reverseCases(
        source,
        CASES.filter((c) => c.family === "F3-url"),
        'if (original_bytes[j] != ":") continue',
        'if (j == i + 3 || original_bytes[j] != ":") continue'
      );
    });
    timed(file, "F3 carries client context across CRLF continuations only", () => {
      reverseCases(
        source,
        CASES.filter((c) => c.family === "F3-crlf"),
        'if (ending && original_bytes[ending] == "\\r") ending--',
        'if (0 && ending && original_bytes[ending] == "\\r") ending--'
      );
    });
    timed(file, "F4 retains public text around empty attached user options", () => {
      for (const c of CASES.filter((c) => c.id.startsWith("F4-"))) {
        const output = run(source, c.input);
        requireHidden(output, c);
        if (!c.secrets.length) expect(output).toBe(c.input);
      }
    });
    timed(file, "F4 bounds each attached-user scan to its current word", () => {
      const original = boundsTrace(source);
      requireBounds(original);
      const mutant = boundsTrace(
        changed(
          source,
          "start = word ~ /^--user=/ ? s1_positions[7] + 1 :",
          "start = word ~ /^--user=/ ? s1_positions[8] :"
        )
      );
      expect(mutant.flags).toBe(8);
      expect(mutant.outside).toBeGreaterThan(0);
      expect(mutant.badStarts).toBe(8);
      expect(() => requireBounds(mutant)).toThrow("F4 colon scan must stay within its own word");
      emit(JSON.stringify({ measurement: "S1-F4-BOUNDS", file, original, mutant, missingGuardRejected: true }));
    });
    timed(file, "F4 keeps empty-user-option growth below quadratic at 4/8/16 KiB", () => {
      const head = "curl ";
      const unit = "--user= ";
      const tail = "--user=public:HEAD_F4 https://example.invalid KEEP_F4";
      const inputs = [4096, 8192, 16384].map((bytes) => {
        const room = bytes - head.length - tail.length;
        const input = head + unit.repeat(Math.floor(room / unit.length)) + tail + "X".repeat(room % unit.length);
        expect(Buffer.byteLength(input)).toBe(bytes);
        return { bytes, input, expected: input.replace("HEAD_F4", "***MASKED***") };
      });
      const calls: { bytes: number; elapsedMs: number }[] = [];
      for (let round = 0; round < 7; round++) {
        for (const c of round % 2 ? [...inputs].reverse() : inputs) {
          const tick = performance.now();
          const output = run(source, c.input);
          calls.push({ bytes: c.bytes, elapsedMs: performance.now() - tick });
          expect(output).toBe(c.expected);
        }
      }
      const fastest = inputs.map((c) => Math.min(...calls.filter((x) => x.bytes === c.bytes).map((x) => x.elapsedMs)));
      const doubling = [fastest[1]! / fastest[0]!, fastest[2]! / fastest[1]!];
      const ratio = fastest[2]! / fastest[0]!;
      emit(
        JSON.stringify({
          measurement: "S1-F4-GROWTH",
          file,
          checkout,
          runtime: { node: process.version, platform: process.platform, arch: process.arch },
          sourceHashes,
          sizes: inputs.map((c) => c.bytes),
          rounds: 7,
          childCapMs: 4000,
          systemPath: SYSTEM_PATH,
          calls,
          fastest,
          doubling,
          ratio,
          strictRatioLimit: 9
        })
      );
      expect(ratio).toBeLessThan(9);
    });
    timed(file, "F5 retains clients across brace arguments and xargs placeholders", () => {
      reverseCases(
        source,
        CASES.filter((c) => c.id.startsWith("F5-")),
        "if (c ~ /[|;&()]/ || (c ~ /[{}]/ && s1_command_start[level] && (i == last || original_bytes[i + 1] ~ /[[:space:]|;&()]/)))",
        "if (c ~ /[|;&(){}]/)"
      );
    });
    timed(file, "F6 masks quoted attribute tails without damaging earlier HTML input guards", () => {
      for (const c of CASES.filter((c) => c.family === "F6-control")) requireHidden(run(source, c.input), c);
      reverseCases(
        source,
        CASES.filter((c) => c.family === "F6-tag"),
        "s1_tag_quoted_tail(s1_tag_value_start, i)",
        's1_at(i, "")'
      );
    });
    timed(file, "F6 caches tag ends rather than rescanning quote-failure suffixes", () => {
      const input = "<x " + String.raw`password=FSCAN_TAG_CACHE9\"`.repeat(16) + "> KEEP_F6_WORK";
      const original = workTrace(source, input, "tag");
      expect(original.calls).toBeGreaterThan(1);
      expect(original.output).not.toContain("FSCAN_TAG_CACHE9");
      expect(original.output).toContain("> KEEP_F6_WORK");
      expect(original.work, "F6 cached tag boundary work").toBeLessThanOrEqual(Buffer.byteLength(input));
      const mutant = changed(
        source,
        "if (at >= s1_tag_end_first && at <= s1_tag_end_last) return s1_tag_end_last",
        "if (0 && at >= s1_tag_end_first && at <= s1_tag_end_last) return s1_tag_end_last"
      );
      const changedTrace = workTrace(mutant, input, "tag");
      expect(changedTrace.calls).toBe(original.calls);
      expect(changedTrace.output).toBe(original.output);
      const requireLinear = (work: number) =>
        expect(work, "F6 tag boundary work must stay linear").toBeLessThanOrEqual(Buffer.byteLength(input));
      requireLinear(original.work);
      expect(changedTrace.work).toBeGreaterThan(Buffer.byteLength(input));
      expect(() => requireLinear(changedTrace.work)).toThrow("F6 tag boundary work must stay linear");
    });
    timed(file, "preserves noncredential commands and all public controls", () => {
      for (const c of CASES.filter((c) => c.family === "public"))
        expect(run(source, c.input), c.id).toBe(c.exact ?? c.input);
    });
  });
}
timed("both", "keeps the two complete shipping mask functions byte-identical", () => {
  expect(masks[0]).toBe(masks[1]);
  expect(sourceHashes[0]).toBe(sourceHashes[1]);
});
