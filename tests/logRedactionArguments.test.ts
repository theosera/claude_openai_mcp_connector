import { describe, expect, it } from "vitest";

import { MASK, redactFragment } from "../packages/log-redaction/src/core.mjs";
import { judgeCase } from "./tools/redactionJudge.js";

const redact = (text: string, kind = "command") => redactFragment({ text, kind });

describe("argument-position credentials (#279)", () => {
  it.each(["mysql", "mysqldump", "mysqladmin", "mariadb", "mariadb-dump", "/usr/bin/mysql"])(
    "masks the glued password of %s",
    (client) => {
      expect(redact(`${client} -pFKARG001 KEEP001`)).toEqual({
        text: `${client} -p${MASK} KEEP001`,
        status: "ok"
      });
    }
  );

  it("masks a spaced mysql password", () => {
    expect(redact("mysql -p FKARG002 KEEP002")).toEqual({ text: `mysql -p ${MASK} KEEP002`, status: "ok" });
  });

  it.each(["-a", "--pass"])("masks redis-cli %s", (flag) => {
    expect(redact(`redis-cli ${flag} FKARG003 KEEP003`)).toEqual({
      text: `redis-cli ${flag} ${MASK} KEEP003`,
      status: "ok"
    });
  });

  it.each(["-u", "--user", "--user="])("masks curl %s while retaining the user", (flag) => {
    const separator = flag.endsWith("=") ? "" : " ";
    expect(redact(`curl ${flag}${separator}KEEPUSER:FKARG004 KEEP004`)).toEqual({
      text: `curl ${flag}${separator}KEEPUSER:${MASK} KEEP004`,
      status: "ok"
    });
  });

  it.each(["'", '"'])("reads blanks inside a %s-quoted password", (quote) => {
    expect(redact(`mysql -p${quote}FKARG005 FKARG006${quote} KEEP005`)).toEqual({
      text: `mysql -p${quote}${MASK}${quote} KEEP005`,
      status: "ok"
    });
    expect(redact(`curl -u ${quote}KEEPUSER:FKARG005 FKARG006${quote} KEEP005`)).toEqual({
      text: `curl -u ${quote}KEEPUSER:${MASK}${quote} KEEP005`,
      status: "ok"
    });
    expect(redact(`curl -u KEEPUSER:${quote}FKARG005 FKARG006${quote} KEEP005`)).toEqual({
      text: `curl -u KEEPUSER:${quote}${MASK}${quote} KEEP005`,
      status: "ok"
    });
  });

  it("masks every joined shell segment of a password", () => {
    const line = `mysql -p'FKARG007'\\''FKARG008'"FKARG009" KEEP007`;
    expect(judgeCase(line, redact(line), ["FKARG007", "FKARG008", "FKARG009"], ["KEEP007"])).toEqual({
      leaked: [],
      broken: [],
      omitted: false
    });
  });

  it.each(["command", "text"])("reads an unquoted prefix joined to a quoted spaced argument in %s", (kind) => {
    for (const command of ["mysql -p", "redis-cli -a", "redis-cli --pass"]) {
      const line = `${command} FKARG042'FKARG043 FKARG044' KEEP042`;
      expect(judgeCase(line, redact(line, kind), ["FKARG042", "FKARG043", "FKARG044"], ["KEEP042"])).toEqual({
        leaked: [],
        broken: [],
        omitted: false
      });
    }
    const line = "redis-cli -a \\\nFKARG045'FKARG046 FKARG047' KEEP045";
    expect(judgeCase(line, redact(line, kind), ["FKARG045", "FKARG046", "FKARG047"], ["KEEP045"])).toEqual({
      leaked: [],
      broken: [],
      omitted: false
    });
  });

  it("reads repeated flags without rescanning or a sentinel exception", () => {
    expect(redact("mysql -pFKARG010 -pFKARG011 KEEP010")).toEqual({
      text: `mysql -p${MASK} -p${MASK} KEEP010`,
      status: "ok"
    });
    expect(redact("redis-cli -a FKARG012 -a FKARG013 KEEP012")).toEqual({
      text: `redis-cli -a ${MASK} -a ${MASK} KEEP012`,
      status: "ok"
    });
    expect(redact("mysql -p***MASKEDP***FKARG014 KEEP014")).toEqual({
      text: `mysql -p${MASK} KEEP014`,
      status: "ok"
    });
  });

  it("keeps quoted SQL words that resemble flags", () => {
    for (const flag of ["-e ", "-e", "--execute ", "--execute=", "--where=", "--where "]) {
      const line = `mysql -pFKARG015 ${flag}'SELECT mysql -price FROM KEEP015'`;
      expect(redact(line)).toEqual({ text: `mysql -p${MASK} ${flag}'SELECT mysql -price FROM KEEP015'`, status: "ok" });
    }
  });

  it.each(["command", "text"])("keeps prefix-joined SQL words opaque in %s", (kind) => {
    for (const flag of ["-e ", "-e", "--execute ", "--execute=", "--where=", "--where "]) {
      const query = `X'SELECT mysql -price '"FROM mysql -price KEEP048"`;
      const line = `mysql -pFKARG048 ${flag}${query}`;
      expect(redact(line, kind)).toEqual({ text: `mysql -p${MASK} ${flag}${query}`, status: "ok" });
    }
  });

  it.each(["\n", "\r\n", "\r"])("continues a client across an escaped %j", (separator) => {
    const line = `redis-cli \\${separator}  -a FKARG016 KEEP016`;
    expect(redact(line)).toEqual({ text: `redis-cli \\${separator}  -a ${MASK} KEEP016`, status: "ok" });
  });

  it("retains separators inside a continued credential", () => {
    expect(redact("mysql -pFKARG017\\\nFKARG018 KEEP017")).toEqual({
      text: `mysql -p${MASK}\n${MASK} KEEP017`,
      status: "ok"
    });
  });

  it.each(["'", '"'])("masks the remaining line after an unclosed %s argument", (quote) => {
    const line = `mysql -p${quote}FKARG019 FKARG020\necho KEEP019`;
    expect(redact(line)).toEqual({ text: `mysql -p${quote}${MASK}\necho KEEP019`, status: "ok" });
  });

  it.each(["command", "text"])("masks truncated joined credentials through their physical line in %s", (kind) => {
    for (const quote of ["'", '"']) {
      for (const flag of ["-u ", "--user ", "--user="]) {
        for (const before of [`${quote}user:`, `user:${quote}`, `${quote}user: `]) {
          const line = `curl ${flag}${before}FKARG054 FKARG055\necho KEEP054`;
          const expected = `curl ${flag}${before.trimEnd()}${MASK}\necho KEEP054`;
          expect(redact(line, kind)).toEqual({ text: expected, status: "ok" });
        }
      }
      for (const command of ["mysql -p", "redis-cli -a ", "redis-cli --pass "]) {
        const line = `${command}FKARG056${quote}FKARG057 FKARG058\necho KEEP056`;
        expect(redact(line, kind)).toEqual({ text: `${command}${MASK}\necho KEEP056`, status: "ok" });
      }
    }
  });

  it("keeps the named-client requirement and command boundaries", () => {
    const line = "mkdir -p KEEP020; ssh -p2222 KEEP021; sort -u source:dest; date -u '+%Y-%m-%dT%H:%M:%SZ'";
    expect(redact(line)).toEqual({ text: line, status: "ok" });
    for (const boundary of [";", "&&", "|", "\n", "\r\n", ")"]) {
      const input = `mysql -pFKARG021 ${boundary} mkdir -p KEEP022`;
      expect(redact(input)).toEqual({ text: `mysql -p${MASK} ${boundary} mkdir -p KEEP022`, status: "ok" });
    }
  });

  it("leaves a curl user without a password readable", () => {
    const line = "curl --user KEEPUSER https://example.test/KEEP023";
    expect(redact(line)).toEqual({ text: line, status: "ok" });
  });

  it("reads logged command strings with source offsets and encoded inner quotes", () => {
    const line = JSON.stringify({ command: 'mysql -h "$H" -pFKARG024 -e "SELECT -price FROM KEEP024"' });
    expect(redact(line)).toEqual({
      text: JSON.stringify({ command: `mysql -h "$H" -p${MASK} -e "SELECT -price FROM KEEP024"` }),
      status: "ok"
    });
    expect(redact(`sh -c "mysql -p'FKARG025 FKARG026' KEEP025"`)).toEqual({
      text: `sh -c "mysql -p'${MASK}' KEEP025"`,
      status: "ok"
    });
  });

  it("reads shell quote joins in a command described as text", () => {
    const line = `curl -u user:'FKARG032'\\''FKARG033' https://example.test/KEEP032`;
    expect(judgeCase(line, redact(line, "text"), ["FKARG032", "FKARG033"], ["KEEP032"])).toEqual({
      leaked: [],
      broken: [],
      omitted: false
    });
  });

  it.each(["command", "text"])("keeps a URL after a quote joining the curl username in %s", (kind) => {
    const line = `curl -u 'user:'"FKARG034 FKARG035" https://example.test/KEEP034`;
    expect(judgeCase(line, redact(line, kind), ["FKARG034", "FKARG035"], ["user", "KEEP034"])).toEqual({
      leaked: [],
      broken: [],
      omitted: false
    });
  });

  it("reads a shell command inside a JSON command string", () => {
    const line = JSON.stringify({ command: "sh -c 'mysql -pFKARG036 KEEP036'" });
    expect(judgeCase(line, redact(line), ["FKARG036"], ["KEEP036"])).toEqual({
      leaked: [],
      broken: [],
      omitted: false
    });
  });

  it("reads an encoded continuation without changing the original JSON escapes", () => {
    const line = JSON.stringify({ command: "mysql \\\n-pFKARG038 KEEP038" });
    expect(redact(line)).toEqual({
      text: JSON.stringify({ command: `mysql \\\n-p${MASK} KEEP038` }),
      status: "ok"
    });
  });

  it("bounds repeated decoding of deeply nested command strings", () => {
    let line = `mysql -pFKARG037 ${"x ".repeat(8192)}KEEP037`;
    for (let depth = 0; depth < 12; depth += 1) line = JSON.stringify(line);
    const result = redact(line);
    expect(result.status).toBe("omitted");
    expect(result).toMatchObject({ reason: "argument_nesting_limit" });
    expect(result.text).not.toContain("FKARG037");
  });

  it.each(["command", "text"])("reads command flags described in %s prose", (kind) => {
    expect(redact("the mysql client won't prompt if you pass -pFKARG027 KEEP027", kind)).toEqual({
      text: `the mysql client won't prompt if you pass -p${MASK} KEEP027`,
      status: "ok"
    });
    for (const command of ["mysql -pFKARG039", "redis-cli -a FKARG039", "curl -u user:FKARG039"]) {
      const line = `the ${command.split(" ")[0]} client won't prompt; ${command} but here's KEEP039`;
      expect(judgeCase(line, redact(line, kind), ["FKARG039"], ["KEEP039"])).toEqual({
        leaked: [],
        broken: [],
        omitted: false
      });
    }
    const quoted = "the mysql client won't prompt if you pass -p'FKARG040 FKARG041' KEEP040";
    expect(judgeCase(quoted, redact(quoted, kind), ["FKARG040", "FKARG041"], ["KEEP040"])).toEqual({
      leaked: [],
      broken: [],
      omitted: false
    });
  });

  it("keeps labels and provider tails covered alongside flags", () => {
    const line = `mysql -pFKARG028 --passphrase 'FKARG029 FKARG030'; redis-cli -a sk-${"A".repeat(24)}FKARG031`;
    const result = redact(line);
    expect(judgeCase(line, result, ["FKARG028", "FKARG029", "FKARG030", "FKARG031"], ["mysql", "redis-cli"])).toEqual({
      leaked: [],
      broken: [],
      omitted: false
    });
  });

  it.each(["command", "text"])("keeps nonempty passwd and passphrase masked alongside flags in %s", (kind) => {
    for (const command of ["mysql -pFKARG049", "redis-cli -a FKARG049", "curl -u user:FKARG049"]) {
      const line = `${command} --passphrase 'FKARG050 FKARG051' --passwd='FKARG052 FKARG053' KEEP049`;
      expect(
        judgeCase(line, redact(line, kind), ["FKARG049", "FKARG050", "FKARG051", "FKARG052", "FKARG053"], ["KEEP049"])
      ).toEqual({
        leaked: [],
        broken: [],
        omitted: false
      });
    }
  });
});
