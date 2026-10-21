import { beforeEach, describe, expect, it, vi } from "vitest";

import { sedEngine } from "./tools/redactionFuzz.js";
import { commandEngine, type Engine, type Fragment } from "./tools/redactionJudge.js";
import { execFileSyncBounded, RUNAWAY_MS } from "./tools/syncChild.js";

vi.mock("./tools/syncChild.js", () => ({
  execFileSyncBounded: vi.fn(),
  RUNAWAY_MS: 300_000
}));

const exec = vi.mocked(execFileSyncBounded);
const fragments: Fragment[] = Array.from({ length: 600 }, (_, index) => ({
  text: `case-${index}`,
  kind: index % 2 === 0 ? "text" : "command"
}));

const engines: Array<{ name: string; create: () => Engine; reply: (input: string) => string }> = [
  {
    name: "command",
    create: () => commandEngine(["DUMMY_ENGINE", "DUMMY_ARG"], "/DUMMY_CWD"),
    reply: (input) =>
      input
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.stringify({ text: (JSON.parse(line) as Fragment).text, status: "ok" }))
        .join("\n")
  },
  { name: "sed", create: () => sedEngine("DUMMY_MASK_FUNCTION"), reply: (input) => input }
];

beforeEach(() => exec.mockReset());

describe.each(engines)("$name engine batches", ({ create, reply }) => {
  it("gives successive bounded children all inputs in their original order", () => {
    exec.mockImplementation((_file, _args, options) => reply(String(options?.input ?? "")));

    expect(create()(fragments)).toEqual(fragments.map(({ text }) => ({ text, status: "ok" })));

    expect(exec).toHaveBeenCalledTimes(3);
    const inputs = exec.mock.calls.map(([, , options]) => String(options?.input ?? ""));
    expect(inputs.map((input) => input.split(input.includes("\0") ? "\0" : "\n").filter(Boolean).length)).toEqual([
      256, 256, 88
    ]);
    for (const [, , options] of exec.mock.calls) expect(options?.timeout).toBe(RUNAWAY_MS);
    expect(fragments[0]).toEqual({ text: "case-0", kind: "text" });
  });

  it("still executes and validates an empty batch", () => {
    exec.mockReturnValue("");

    expect(create()([])).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[2]?.input).toBe("");
    expect(exec.mock.calls[0]?.[2]?.timeout).toBe(RUNAWAY_MS);
  });

  it("propagates a later child's failure and never starts the remaining batch", () => {
    const error = new Error("DUMMY_CAP_FAILURE");
    exec
      .mockImplementationOnce((_file, _args, options) => reply(String(options?.input ?? "")))
      .mockImplementationOnce(() => {
        throw error;
      });

    expect(() => create()(fragments)).toThrow(error);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

it("validates every sed input before starting even the first batch", () => {
  expect(() => sedEngine("DUMMY_MASK")([...fragments, { text: "bad\0input", kind: "text" }])).toThrow(
    "an input carries a NUL"
  );
  expect(exec).not.toHaveBeenCalled();
});

it("still rejects a sed child's malformed result count", () => {
  exec.mockReturnValue("only-one\0");
  expect(() => sedEngine("DUMMY_MASK")(fragments)).toThrow("1 outputs for 256 inputs");
  expect(exec).toHaveBeenCalledTimes(1);
});
