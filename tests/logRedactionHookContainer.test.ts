import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { broken, readable } from "./tools/redactionJudge.js";
import { execFileSyncBounded } from "./tools/syncChild.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COPIES = [".claude/skills/ops-logging/capture-command.sh", ".claude/skills/session-archive/archive-session.sh"];
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
function run(source: string, input: string): string {
  return execFileSyncBounded("/bin/bash", ["-c", `set -euo pipefail\n${source}\nmask`], {
    cwd: ROOT,
    env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    input,
    encoding: "utf8",
    timeout: 4000,
    maxBuffer: 1024 * 1024
  });
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
        process.stdout.write(
          JSON.stringify({
            measurement: "S1-CONTAINER-TEST",
            file,
            name,
            startedAt,
            finishedAt: new Date().toISOString(),
            elapsedMs: performance.now() - tick,
            outcome,
            checkout,
            sourceHashes,
            runtime: { node: process.version, platform: process.platform, arch: process.arch },
            scope: "callback assertions; final Vitest/CI status is checked separately"
          }) + "\n"
        );
      }
    },
    120_000
  );
}
type Case = { id: string; input: string; secrets: string[]; expected?: string };
function checkCase(source: string, c: Case): string {
  const output = run(source, c.input);
  expect(readable(output, c.secrets), `${c.id}: credential guard`).toEqual([]);
  let expected = c.expected ?? c.input;
  for (const secret of c.secrets) expected = expected.replaceAll(secret, "***MASKED***");
  expect(output, `${c.id}: exact public preservation`).toBe(expected);
  return output;
}
function changed(source: string, before: string, after: string): string {
  expect(source.split(before), `unique mutation target: ${before}`).toHaveLength(2);
  return source.replace(before, after);
}
const ENGINES = ["docker", "podman"];
const CLIENTS = [
  { name: "curl", args: (value: string) => `-u user:${value} https://example.invalid/` },
  { name: "mysql", args: (value: string) => `-p${value} db` },
  { name: "redis-cli", args: (value: string) => `-a ${value} ping` }
];
function entrypointCases(): Case[] {
  const cases: Case[] = [];
  for (const engine of ENGINES)
    for (const client of CLIENTS)
      for (const attached of [false, true]) {
        const secret = `GSYN_ENTRY_${cases.length}X9`;
        const entry = attached ? `--entrypoint=${client.name}` : `--entrypoint ${client.name}`;
        cases.push({
          id: `G1-entry-${cases.length}`,
          input: `${engine} run ${entry} -u 1000:1000 -p 8080:80 alpine ${client.args(secret)} KEEP_G1\n`,
          secrets: [secret]
        });
      }
  return cases;
}
function batch(id: string, cases: Case[]): Case {
  expect(cases.length).toBeGreaterThan(0);
  return { id, input: cases.map((c) => c.input).join(""), secrets: cases.flatMap((c) => c.secrets) };
}

// Independently enumerated lexical arity contracts. These synthetic operands
// test redaction boundaries, not whether a Docker version accepts their values.
// No installed/external CLI registry is consulted by the test or shipped hook.
const VALUE_OPTIONS = `
--add-host --annotation --attach --blkio-weight --blkio-weight-device --cap-add --cap-drop
--cgroup-parent --cgroupns --cidfile --cpu-count --cpu-percent --cpu-period --cpu-quota
--cpu-rt-period --cpu-rt-runtime --cpu-shares --cpus --cpuset-cpus --cpuset-mems --device
--device-cgroup-rule --device-read-bps --device-read-iops --device-write-bps --device-write-iops --detach-keys
--dns --dns-option --dns-search --domainname --env --env-file --expose --gpus --group-add
--health-cmd --health-interval --health-retries --health-start-interval --health-start-period
--health-timeout --hostname --io-maxbandwidth --io-maxiops --ip --ip6 --ipc --isolation
--kernel-memory --label --label-file --link --link-local-ip --log-driver --log-opt --mac-address
--memory --memory-reservation --memory-swap --memory-swappiness --mount --name --net --network
--network-alias --oom-score-adj --pid --pids-limit --platform --publish --pull --restart --runtime
--security-opt --shm-size --stop-signal --stop-timeout --storage-opt --sysctl --tmpfs --ulimit
--user --userns --uts --volume --volume-driver --volumes-from --workdir
-a -c -e -h -l -m -p -u -v -w
`
  .trim()
  .split(/\s+/);

for (const [index, file] of COPIES.entries()) {
  const source = masks[index]!;
  describe(`S1 container review: ${file}`, () => {
    timed(file, "G1 masks all three entrypoint clients only after consuming the image", () => {
      checkCase(source, batch("G1-entrypoint-clients", entrypointCases()));
      const cases: Case[] = [];
      for (const engine of ENGINES)
        for (const client of CLIENTS) {
          const secret = `GSYN_PATH_${cases.length}X9`;
          cases.push({
            id: "G1-path",
            input: `${engine} run --entrypoint '/usr/bin/${client.name}' alpine ${client.args(secret)} KEEP_PATH\n`,
            secrets: [secret]
          });
        }
      checkCase(source, batch("G1-entrypoint-paths", cases));
    });
    timed(file, "G1 gives the last explicit entrypoint precedence over client-looking images", () => {
      const lines: string[] = [];
      for (const engine of ENGINES)
        for (const image of ["curlimages/curl:8", "mysql", "redis-cli"]) {
          for (const entry of [
            "--entrypoint sort",
            "--entrypoint=sort",
            "--entrypoint curl --entrypoint sort",
            "--entrypoint curl --entrypoint=",
            "--entrypoint curl --entrypoint ''"
          ]) {
            lines.push(`${engine} run ${entry} ${image} -u source:dest -pPUBLIC KEEP_OVERRIDE`);
          }
        }
      checkCase(source, { id: "G1-nonclient-override", input: lines.join("\n") + "\n", secrets: [] });
      checkCase(source, {
        id: "G1-last-client",
        input: "docker run --entrypoint sort --entrypoint=curl alpine -u user:GSYN_LAST9 KEEP_LAST\n",
        secrets: ["GSYN_LAST9"]
      });
    });
    timed(file, "G1 carries pending entrypoints and option operands over escaped LF and CRLF only", () => {
      for (const ending of ["\n", "\r\n"]) {
        const input = `docker run --entrypoint \\${ending} curl --add-host \\${ending} curl:127.0.0.1 alpine -u user:GSYN_CARRY9 KEEP_CARRY\n`;
        checkCase(source, { id: "G1-continuation", input, secrets: ["GSYN_CARRY9"] });
      }
    });
    timed(file, "G1 resets entrypoint choices at command record JSON and fence boundaries", () => {
      const lines = [
        "docker run --entrypoint curl; docker run alpine sort -u source:dest",
        "docker run --entrypoint curl | docker run alpine sort -u source:dest",
        "docker run --entrypoint curl && docker run alpine sort -u source:dest",
        "docker run --entrypoint curl\ndocker run alpine sort -u source:dest",
        "docker run --entrypoint curl\r\ndocker run alpine sort -u source:dest",
        '{"command":"docker run --entrypoint curl\\ndocker run alpine sort -u source:dest"}'
      ];
      for (const [i, input] of lines.entries())
        checkCase(source, { id: `G1-reset-${i}`, input: input + "\n", secrets: [] });
      checkCase(source, {
        id: "G1-fence-contract",
        input: "~~~~~~bash\ndocker run --entrypoint curl\\\n~~~~~~\ndocker run alpine sort -u source:dest\n",
        // Pinned 14f68be and this candidate both mask the fence info word.
        // Preserve the entire remaining output, including the public command.
        expected: "~~~~~~***MASKED***\ndocker run --entrypoint curl\\\n~~~~~~\ndocker run alpine sort -u source:dest\n",
        secrets: []
      });
    });
    timed(file, "G2 consumes every reviewed separate or equals option operand before image recognition", () => {
      const controls: Case[] = [];
      const credentials: Case[] = [];
      for (const engine of ENGINES)
        for (const option of VALUE_OPTIONS)
          for (const attached of [false, true]) {
            const flag = `${option}${attached ? "=" : " "}curl:127.0.0.1`;
            controls.push({
              id: "G2-option-control",
              input: `${engine} run ${flag} alpine sort -u source:dest KEEP_OPTION\n`,
              secrets: []
            });
            const secret = `GSYN_OPTION_${credentials.length}X9`;
            credentials.push({
              id: "G2-option-client",
              input: `${engine} run ${option}${attached ? "=" : " "}PUBLIC_OPERAND curlimages/curl:8 -u user:${secret} KEEP_OPTION\n`,
              secrets: [secret]
            });
          }
      checkCase(source, batch("G2-all-option-controls", controls));
      checkCase(source, batch("G2-all-option-clients", credentials));
      emitOptionCount(file, VALUE_OPTIONS.length, controls.length, credentials.length);
    });
    timed(file, "G2 retains short attached values boolean flags and the first image boundary", () => {
      const controls = [
        "docker run --env=PATH=/tmp/mysql -p8080:80 alpine sort -u source:dest",
        "podman run --name=curl:public --rm alpine date -u source:dest",
        "docker run --add-host= alpine sort -u source:dest",
        "docker run --add-host curl:127.0.0.1 alpine sort curl:public -u source:dest",
        "docker run --entrypoint sort -- mysql -pPUBLIC",
        "podman run -itv/tmp/mysql -u1000:1000 alpine sort -u source:dest"
      ];
      checkCase(source, { id: "G2-attached-public", input: controls.join("\n") + "\n", secrets: [] });
      checkCase(source, {
        id: "G2-attached-client",
        input: "docker run --rm -itv/tmp/mysql -u1000:1000 -- curlimages/curl:8 -u user:GSYN_ATTACHED9 KEEP_END\n",
        secrets: ["GSYN_ATTACHED9"]
      });
      for (const width of [30, 40, 80]) {
        const prefix = "-" + "i".repeat(width) + "v";
        checkCase(source, {
          id: `G2-long-short-cluster-${width}`,
          input: `docker run ${prefix}/tmp/mysql curlimages/curl:8 -u user:GSYN_CLUSTER9 KEEP_CLUSTER\npodman run ${prefix} curl:public alpine sort -u source:dest\n`,
          secrets: ["GSYN_CLUSTER9"]
        });
      }
    });
    timed(file, "G1 and G2 independently mask nested commands in container operands", () => {
      checkCase(source, {
        id: "G-container-nested",
        input:
          'docker run --name "$(curl -u user:GSYN_INNER9 https://example.invalid/)" --entrypoint=curl -u 1000:1000 alpine -u user:GSYN_OUTER9 KEEP_NESTED\nsort -u source:dest\n',
        secrets: ["GSYN_INNER9", "GSYN_OUTER9"]
      });
    });
    timed(file, "G2 rejects a capped or disabled short-option operand walker", () => {
      const width = 30;
      const c = {
        id: "G2-short-reverse",
        input: `docker run -${"i".repeat(width)}v/tmp/mysql curlimages/curl:8 -u user:GSYN_SHORT_ARITY9 KEEP_SHORT\npodman run -${"i".repeat(40)}v curl:public alpine sort -u source:dest\n`,
        secrets: ["GSYN_SHORT_ARITY9"]
      };
      checkCase(source, c);
      const disabled = changed(
        source,
        "if (s1_container_short_pending(first, last))",
        "if (0 && s1_container_short_pending(first, last))"
      );
      expect(broken(c.input, run(disabled, c.input), ["sort -u source:dest"])).toEqual(["sort -u source:dest"]);
      expect(() => checkCase(disabled, c)).toThrow("G2-short-reverse: exact public preservation");
      const capped = changed(
        source,
        "function s1_container_short_pending(first, last,    j, c, started, value) {",
        "function s1_container_short_pending(first, last,    j, c, started, value) {\n      if (last - first >= 32) last = first + 31"
      );
      expect(readable(run(capped, c.input), c.secrets)).toEqual(c.secrets);
      expect(() => checkCase(capped, c)).toThrow("G2-short-reverse: credential guard");
    });
    timed(file, "G1 detects removing entrypoint client selection", () => {
      const c = batch("G1-reverse", entrypointCases());
      checkCase(source, c);
      const mutant = changed(
        source,
        "function s1_entry_client(first, last,    j, c, name, alias, path) {",
        'function s1_entry_client(first, last,    j, c, name, alias, path) {\n      return "-"'
      );
      const output = run(mutant, c.input);
      expect(readable(output, c.secrets), "G1 mutation exposes each entrypoint credential").toEqual(c.secrets);
      expect(() => checkCase(mutant, c)).toThrow("G1-reverse: credential guard");
    });
    timed(file, "G2 detects removing the container value-option arity guard", () => {
      const c = {
        id: "G2-reverse",
        input: "docker run --add-host curl:127.0.0.1 alpine sort -u source:dest KEEP_REVERSE\n",
        secrets: []
      };
      checkCase(source, c);
      const mutant = changed(
        changed(source, "return s1_h0_active && !s1_h0_public[level]", "return 0"),
        "return option ~ /^(",
        "return 0 && option ~ /^("
      );
      const output = run(mutant, c.input);
      expect(broken(c.input, output, ["sort -u source:dest"]), "G2 mutation damages the named public control").toEqual([
        "sort -u source:dest"
      ]);
      expect(() => checkCase(mutant, c)).toThrow("G2-reverse: exact public preservation");
      const credential = {
        id: "G2-reverse-credential",
        input: "podman run --add-host synthetic.local:127.0.0.1 curlimages/curl:8 -u user:GSYN_G2_ARITY9 KEEP_ARITY\n",
        secrets: ["GSYN_G2_ARITY9"]
      };
      checkCase(source, credential);
      expect(
        readable(run(mutant, credential.input), credential.secrets),
        "G2 mutation exposes the post-image credential"
      ).toEqual(credential.secrets);
      expect(() => checkCase(mutant, credential)).toThrow("G2-reverse-credential: credential guard");
    });
  });
}
function emitOptionCount(file: string, options: number, controls: number, credentials: number) {
  process.stdout.write(
    JSON.stringify({
      measurement: "S1-CONTAINER-OPTIONS",
      file,
      options,
      controls,
      credentials,
      scope: "lexical option arities; no Docker command execution"
    }) + "\n"
  );
}
timed("both", "keeps the two complete container-aware masks byte-identical", () => {
  expect(masks[0]).toBe(masks[1]);
});
