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

  /**
   * Everything the assertions need, taken from ONE open handle.
   *
   * `stat(path)` followed by `readFile(path)` would let "the inode changed" and
   * "the content is the new one" describe two different files — the same
   * check-then-use the code under test exists to remove, and CodeQL is right to
   * flag it even in a test whose directory nothing else touches.
   */
  async function inspect(): Promise<{ ino: bigint; mode: bigint; uid: number; content: string }> {
    const handle = await fs.open(target, "r");
    try {
      const stats = await handle.stat({ bigint: true });
      return {
        ino: stats.ino,
        mode: stats.mode & 0o777n,
        uid: Number(stats.uid),
        content: await handle.readFile("utf8")
      };
    } finally {
      await handle.close();
    }
  }

  async function currentOwner(): Promise<{ mode: number; uid: number; gid: number }> {
    const handle = await fs.open(target, "r");
    try {
      const stats = await handle.stat();
      return { mode: stats.mode & 0o777, uid: stats.uid, gid: stats.gid };
    } finally {
      await handle.close();
    }
  }

  it("replaces the file by rename, keeping its permission bits", async () => {
    const before = await inspect();

    await replaceFileAtomically(target, "replaced\n", await currentOwner());

    const after = await inspect();
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode).toBe(0o600n);
    expect(after.content).toBe("replaced\n");
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
    const after = await inspect();
    expect(after.content).toBe("original\n");
    expect(after.uid).toBe(owner.uid);
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
    expect((await inspect()).content).toBe("replaced\n");
  });
});
