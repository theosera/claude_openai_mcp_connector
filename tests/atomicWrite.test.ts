import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceFileAtomically } from "../src/atomicWrite.js";

describe("replaceFileAtomically", () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-atomic-"));
    target = path.join(dir, "note.md");
    await fs.writeFile(target, "original\n", { encoding: "utf8", mode: 0o600 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function currentOwner(): Promise<{ mode: number; uid: number; gid: number }> {
    const stats = await fs.stat(target);
    return { mode: stats.mode & 0o777, uid: stats.uid, gid: stats.gid };
  }

  it("replaces the file by rename, keeping its permission bits", async () => {
    const before = await fs.stat(target, { bigint: true });

    await replaceFileAtomically(target, "replaced\n", await currentOwner());

    const after = await fs.stat(target, { bigint: true });
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777n).toBe(0o600n);
    expect(await fs.readFile(target, "utf8")).toBe("replaced\n");
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  // The security case. `rename` needs write permission on the DIRECTORY, not
  // ownership of the target, so a process can replace a note owned by someone
  // else and then be unable to chown the replacement back to them. Publishing it
  // anyway would silently transfer the note. Forced through the handle rather
  // than by arranging two real uids, because the outcome must be the same for a
  // root CI runner (where a real chown would succeed) and an unprivileged one.
  it("refuses to publish a replacement whose ownership could not be restored", async () => {
    const owner = await currentOwner();
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      handle.chown = async () => {
        throw Object.assign(new Error("EPERM: operation not permitted, fchown"), { code: "EPERM" });
      };
      return handle;
    });

    await expect(replaceFileAtomically(target, "replaced\n", { ...owner, uid: owner.uid + 1 })).rejects.toThrow(
      /ownership/i
    );

    // The note keeps its old contents AND its old owner, and no debris is left.
    expect(await fs.readFile(target, "utf8")).toBe("original\n");
    expect((await fs.stat(target)).uid).toBe(owner.uid);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not chown at all when the temp already carries the target's ids", async () => {
    const owner = await currentOwner();
    const realOpen = fs.open.bind(fs);
    const chown = vi.fn();
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      handle.chown = chown as unknown as typeof handle.chown;
      return handle;
    });

    await replaceFileAtomically(target, "replaced\n", owner);

    expect(chown).not.toHaveBeenCalled();
    expect(await fs.readFile(target, "utf8")).toBe("replaced\n");
  });
});
