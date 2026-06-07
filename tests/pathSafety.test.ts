import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertRelativePath, relativeToRoot, toPosixPath } from "../src/pathSafety.js";

describe("assertRelativePath", () => {
  it("accepts a normal vault-relative path", () => {
    expect(assertRelativePath("projects/claude/planning/connector-plan.md")).toBe(
      path.normalize("projects/claude/planning/connector-plan.md")
    );
  });

  it("NFC-normalizes a decomposed (NFD) filename to its composed form", () => {
    const composed = String.fromCharCode(0x00e9); // é as a single code point (NFC)
    const decomposed = String.fromCharCode(0x65, 0x0301); // e + combining acute (NFD)
    expect(assertRelativePath(`caf${decomposed}.md`)).toBe(path.normalize(`caf${composed}.md`));
  });

  it("rejects an empty / whitespace-only path", () => {
    expect(() => assertRelativePath("   ")).toThrow(/required/);
  });

  it("rejects a non-string input", () => {
    // The MCP boundary uses zod, but assertRelativePath defends itself too.
    expect(() => assertRelativePath(undefined as unknown as string)).toThrow(/must be a string/);
  });

  it("rejects parent-directory traversal", () => {
    expect(() => assertRelativePath("../outside.md")).toThrow(/escapes/);
    expect(() => assertRelativePath("a/b/../../../etc/passwd")).toThrow(/escapes/);
  });

  it("rejects an absolute path", () => {
    expect(() => assertRelativePath("/etc/passwd")).toThrow(/Absolute/);
  });

  it("rejects a home-directory reference", () => {
    expect(() => assertRelativePath("~/secret.md")).toThrow(/Home-relative/);
  });

  it("rejects percent-encoded traversal", () => {
    expect(() => assertRelativePath("%2e%2e/secret.md")).toThrow(/escapes/);
    expect(() => assertRelativePath("%2e%2e%2foutside.md")).toThrow(/escapes/);
    expect(() => assertRelativePath("..%2f..%2fetc%2fpasswd")).toThrow(/escapes/);
  });

  it("rejects an encoded traversal carrying a malformed escape (fail-closed)", () => {
    // decodeURIComponent throws on `%ZZ`; a lenient downstream decoder would
    // still yield `../secret%ZZ.md`, so the guard must reject — not fall back to
    // validating only the raw string.
    expect(() => assertRelativePath("%2e%2e%2fsecret%ZZ.md")).toThrow(/escapes/);
  });

  it("accepts a legitimate filename containing a stray percent sign", () => {
    // `%do` is not a valid escape; lenient decode leaves it literal, so this is
    // not treated as traversal (guards against over-rejection).
    expect(assertRelativePath("100%done.md")).toBe(path.normalize("100%done.md"));
  });

  it("rejects control characters and NUL bytes", () => {
    expect(() => assertRelativePath(`a${String.fromCharCode(0)}b.md`)).toThrow(/control/);
    expect(() => assertRelativePath(`a${String.fromCharCode(9)}b.md`)).toThrow(/control/);
    expect(() => assertRelativePath(`a${String.fromCharCode(0x7f)}b.md`)).toThrow(/control/);
  });

  it("rejects an over-long path", () => {
    expect(() => assertRelativePath(`${"a".repeat(600)}.md`)).toThrow(/too long/);
  });
});

describe("relativeToRoot", () => {
  it("returns a posix path for a path inside root", () => {
    const root = path.resolve("/tmp/vault");
    expect(relativeToRoot(root, path.join(root, "a", "b.md"))).toBe("a/b.md");
  });

  it("rejects a path outside root", () => {
    const root = path.resolve("/tmp/vault");
    expect(() => relativeToRoot(root, path.resolve("/tmp/other/secret.md"))).toThrow(/escapes/);
  });
});

describe("toPosixPath", () => {
  it("normalizes OS separators to forward slashes", () => {
    expect(toPosixPath(path.join("a", "b", "c"))).toBe("a/b/c");
  });
});
