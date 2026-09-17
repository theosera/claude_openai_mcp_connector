import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { MASK, redactText } from "../.claude/skills/_shared/redact-log.mjs";

/**
 * Acceptance tests for log redaction, written against the protection the repair
 * is meant to deliver -- NOT against what ships today. Most of these are RED on
 * the current implementation, deliberately.
 *
 * They come from an adversarial review that reconstructed a USABLE private key
 * out of a masked note: rewrapping the body at 8 characters per line puts every
 * line under the in-range run floor of 12 and under the whole-line catch-all
 * floor of 32, so nothing matches and the key survives intact. `openssl` accepted
 * the reconstruction. The outer fence was undamaged throughout, which is the
 * point worth carrying: a healthy fence is not evidence that a key was redacted.
 *
 * The current design cannot close that by tuning a floor. Each rule's output is
 * the next rule's input, so a marker, an `authorization` anchor or a closing
 * quote can be consumed before the rule that needed it ever runs. The repair
 * decides every span against the ORIGINAL text and substitutes once, at the end.
 *
 * `redact()` below is the only seam. Today it drives the shipped sed pipeline;
 * a later stage points it at the shared redactor and every expectation here
 * stays as written. If a test in this file starts passing without the seam
 * moving, read that as the mask having changed, not as the case being fixed.
 */

const DASHES = "-".repeat(5);
const SSH2_DASHES = "-".repeat(4);
/** A synthetic marker string, never a real credential. */
const CANARY = `C4N4RY${"_"}x9`;

/**
 * The seam. Stage 3 points it at the shared redactor; every expectation below is
 * unchanged from when it drove the shipped sed pipeline. A case that flipped
 * green here flipped because the redactor covers it, not because the test moved.
 */
function redact(input: string): string {
  return redactText(input).text;
}

/** Wraps `body` at `width` characters, the way a terminal or an editor would. */
function rewrap(body: string, width: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < body.length; at += width) out.push(body.slice(at, at + width));
  return out;
}

const PREFIXES: Array<[string, (line: string, n: number) => string]> = [
  ["no prefix", (line) => line],
  ["a `cat -n` line number", (line, n) => `${String(n).padStart(6)}\t${line}`],
  ["a `> ` quote", (line) => `> ${line}`],
  ["a `grep -n` file:line:", (line, n) => `sample.txt:${n}:${line}`]
];

function armor(label: string, body: string[], prefix = PREFIXES[0][1], dashes = DASHES): string {
  const open = `${dashes}${dashes === DASHES ? "" : " "}BEGIN ${label}${dashes === DASHES ? "" : " "}${dashes}`;
  const close = `${dashes}${dashes === DASHES ? "" : " "}END ${label}${dashes === DASHES ? "" : " "}${dashes}`;
  return [open, ...body, close].map((line, index) => prefix(line, index + 1)).join("\n");
}

/** A body that is base64-shaped but carries no key material. */
const SYNTHETIC_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDF3xMhFHkPqRsT";

describe("log redactor: credential values", () => {
  it("A01 masks a bare value that opens with five dashes", () => {
    // Five dashes are the marker's own prefix, so the shipped value class refuses
    // to cross them and the whole value survives. A value is a value wherever the
    // dashes sit.
    expect(redact(`token=${DASHES}${CANARY}`)).not.toContain(CANARY);
  });

  it("A02 masks the whole value when five dashes sit mid-value", () => {
    expect(redact(`Bearer ab${DASHES}${CANARY}`)).not.toContain(CANARY);
  });

  it("A03 masks a value made only of dashes", () => {
    for (const line of ["password=-", "password=----", `password=${DASHES}`]) {
      const out = redact(line);
      expect(out, line).toContain("***MASKED***");
      expect(out.replace("***MASKED***", ""), line).not.toMatch(/-/);
    }
  });

  it("A04 masks both a dashed password and a key block sharing one line", () => {
    const line = `{"password":"abc${DASHES}${CANARY}","key":"${DASHES}BEGIN RSA PRIVATE KEY${DASHES}"}`;
    const out = redact(line);
    expect(out).not.toContain(CANARY);
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("A05 protects that password identically with the key block removed", () => {
    expect(redact(`{"password":"abc${DASHES}${CANARY}"}`)).not.toContain(CANARY);
  });

  it("A15 keeps the surrounding structure while removing every value", () => {
    const cases = [
      `{"access_token":"eyJhbGciOiJIUzI1NiJ9.${CANARY}-","token_type":"Bearer","expires_in":3600}`,
      `{'api_key':'${CANARY}-'}`,
      `password: "p@ss ${CANARY}-"`,
      `password: "p@ss \\"quoted\\" ${CANARY}"`
    ];
    for (const line of cases) {
      const out = redact(line);
      expect(out, line).not.toContain(CANARY);
      // The data structure itself must survive: a reader has to see that a token
      // was there, and which field it was.
      if (line.startsWith("{"))
        expect(out, line).toContain(
          "token_type" in {} ? "" : line.includes("access_token") ? "access_token" : "api_key"
        );
    }
  });
});

describe("log redactor: private key armor", () => {
  it("A06 removes the body at every rewrap width, and the result is unusable", () => {
    // The review's core case. 64 characters per line is masked today; 8 is not,
    // and 8 is what a narrow terminal or an editor produces.
    let real: string;
    try {
      real = execFileSync("openssl", ["genpkey", "-algorithm", "ed25519"], { encoding: "utf8" });
    } catch {
      // No openssl here: fall back to the synthetic body. The width behaviour is
      // what this case is about, and it does not depend on the bytes being a key.
      real = "";
    }
    const body = real
      ? real
          .split("\n")
          .filter((line) => line && !line.startsWith("-"))
          .join("")
      : SYNTHETIC_BODY;

    for (const width of [64, 32, 12, 8, 4]) {
      const lines = rewrap(body, width);
      const out = redact(armor("PRIVATE KEY", lines));
      const survived = lines.filter((line) => out.includes(line));
      expect(survived, `${width} chars per line`).toEqual([]);
    }
  });

  it("A07 removes the rewrapped body behind every prefix a tool adds", () => {
    const lines = rewrap(SYNTHETIC_BODY, 8);
    for (const [label, prefix] of PREFIXES) {
      const out = redact(armor("PRIVATE KEY", lines, prefix));
      expect(
        lines.filter((line) => out.includes(line)),
        label
      ).toEqual([]);
    }
  });

  it("A08 removes an SSH2 body in the form ssh-keygen actually writes", () => {
    // `---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----`: four dashes and a space, not
    // five and none. The five-dash spelling is not a stand-in for this one.
    const lines = rewrap(SYNTHETIC_BODY, 32);
    for (const [label, prefix] of PREFIXES) {
      const out = redact(armor("SSH2 ENCRYPTED PRIVATE KEY", lines, prefix, SSH2_DASHES));
      expect(
        lines.filter((line) => out.includes(line)),
        label
      ).toEqual([]);
    }
  });

  it("A09 removes a PGP private key block and a PGP message", () => {
    const lines = rewrap(SYNTHETIC_BODY, 32);
    for (const label of ["PGP PRIVATE KEY BLOCK", "PGP MESSAGE"]) {
      for (const [pname, prefix] of PREFIXES) {
        const out = redact(armor(label, lines, prefix));
        expect(
          lines.filter((line) => out.includes(line)),
          `${label} / ${pname}`
        ).toEqual([]);
      }
    }
  });

  it("A10 does not open the range on public armor", () => {
    // The range's reach is wide -- an opened range eats every long run to the
    // next fence -- so opening it on a certificate destroys more than it
    // protects. Body lines are kept UNDER the catch-all's 32-character floor
    // here, because that catch-all is a separate guard with its own reason to
    // exist (see A10b) and this case is about the range, not about it.
    const lines = rewrap(SYNTHETIC_BODY, 24);
    for (const label of ["CERTIFICATE", "RSA PUBLIC KEY", "PGP PUBLIC KEY BLOCK", "PGP SIGNATURE", "X509 CRL"]) {
      const out = redact(armor(label, lines));
      expect(
        lines.filter((line) => out.includes(line)),
        label
      ).toEqual(lines);
    }
  });

  it("A10b still removes any 32+ base64 line, public armor included", () => {
    // The marker-less catch-all is the only thing covering a key body pasted
    // without its BEGIN line, so it is not narrowed for public armor's sake.
    // Written down because the first draft of A10 used 32-character lines and
    // read this deliberate over-masking as a defect.
    const lines = rewrap(SYNTHETIC_BODY, 32);
    const out = redact(armor("CERTIFICATE", lines));
    expect(out).toContain("BEGIN CERTIFICATE");
    expect(lines.filter((line) => out.includes(line))).toEqual([]);
  });

  it("A11 closes the span at END and keeps what follows", () => {
    const sha = "a1b2c3d4e5f6a7b8c9d0";
    const keyPath = "/home/runner/work/repo/checkout";
    const block = armor("PRIVATE KEY", rewrap(SYNTHETIC_BODY, 32));
    const out = redact(`${block}\ncommit ${sha}\npath ${keyPath}`);
    expect(out).toContain(sha);
    expect(out).toContain(keyPath);
    expect(out).not.toContain(SYNTHETIC_BODY.slice(0, 32));
  });

  it("A12 does not let a tilde run inside the block end the span", () => {
    // A `~~~ label` line is input data. Treating it as a terminator lets an
    // attacker close the span before the body starts.
    const lines = rewrap(SYNTHETIC_BODY, 32);
    const body = [`${"~".repeat(3)} label`, ...lines];
    const out = redact(armor("PRIVATE KEY", body, PREFIXES[1][1]));
    expect(lines.filter((line) => out.includes(line))).toEqual([]);
  });

  it("A13 masks a credential that sits inside an open block", () => {
    const block = [
      `${DASHES}BEGIN PRIVATE KEY${DASHES}`,
      `authorization: ${CANARY}`,
      `${DASHES}END PRIVATE KEY${DASHES}`
    ];
    expect(redact(block.join("\n"))).not.toContain(CANARY);
  });

  it("A10c keeps a `KEY BLOCK` label intact instead of eating it", () => {
    // The previous design broke this line: the bare keyword rule read `KEY BLOCK`
    // as keyword + separator + value and masked `BLOCK`, emitting
    // `-----BEGIN PGP PUBLIC KEY ***MASKED***-----`. Nothing about that depended
    // on the block being secret, which is both the general form of the PGP
    // private-key finding and the reason widening the marker regex to admit
    // ` BLOCK` never reached it -- the label was already gone by then.
    //
    // Per-form delimiters have no keyword rule running ahead of them, so there
    // is nothing to lose the label to.
    const lines = rewrap(SYNTHETIC_BODY, 24);

    // Public: markers and body both survive.
    const pub = redact(armor("PGP PUBLIC KEY BLOCK", lines));
    expect(pub).toContain("BEGIN PGP PUBLIC KEY BLOCK");
    expect(pub).toContain("END PGP PUBLIC KEY BLOCK");

    // Private: removed as a block. The distinction that matters is that it goes
    // because it was recognised, not because its label was consumed.
    const priv = redact(armor("PGP PRIVATE KEY BLOCK", lines));
    expect(lines.filter((line) => priv.includes(line))).toEqual([]);
  });

  it("A10d omits the body when a BEGIN has no matching END", () => {
    // A span to end-of-input would swallow whatever follows on a guess, and
    // leaving the block open is how prefixed bodies leaked before. The body is
    // dropped and the reason recorded, distinguishably from an ordinary mask.
    const result = redactText(`${DASHES}BEGIN PGP PRIVATE KEY BLOCK${DASHES}\nbody line`);
    expect(result.status).toBe("omitted");
    expect(result.reason).toBe("unterminated_private_armor");
    expect(result.text).not.toContain("body line");
    expect(result.text).not.toBe(MASK);
  });
});

describe("log redactor: failure and boundary policy", () => {
  it("A16 does not stall on an unterminated quoted value", () => {
    // Measured at roughly quadratic growth today, and about twice the cost of the
    // previous tip at 128 KiB. The bound is what matters, not the constant.
    for (const kib of [32, 64]) {
      const line = `{"password":"${"a".repeat(kib * 1024)}`;
      const started = Date.now();
      const out = redact(line);
      const elapsed = Date.now() - started;
      expect(out, `${kib} KiB`).not.toContain("a".repeat(64));
      expect(elapsed, `${kib} KiB took ${elapsed}ms`).toBeLessThan(3000);
    }
  });

  // The cases below need the shared redactor's status contract, which does not
  // exist yet. They are listed rather than written so the contract is designed
  // against them instead of around them.
  it.todo("A14 omits an unterminated fragment's body and keeps the next fragment");
  it.todo("A17 records the fixed omission output when the redactor is absent or fails");
  it.todo("A18 keeps fence parity and real speaker headings through the real renderer");
});
