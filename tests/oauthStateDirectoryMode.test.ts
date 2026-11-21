import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { OAuthStore } from "../src/oauth/store.js";

function storeAt(file: string): OAuthStore {
  return new OAuthStore({
    accessTokenTtlSec: 60,
    refreshTokenTtlSec: 600,
    codeTtlSec: 60,
    persistPath: file,
    persistSecret: randomUUID()
  });
}

it("saves OAuth state with mode 0700 on the existing parent directory and 0600 on the file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-mode-"));
  try {
    const dir = path.join(root, "state");
    await fs.mkdir(dir);
    await fs.chmod(dir, 0o750);
    const file = path.join(dir, "state.json");
    const store = new OAuthStore({
      accessTokenTtlSec: 60,
      refreshTokenTtlSec: 600,
      codeTtlSec: 60,
      persistPath: file,
      persistSecret: randomUUID()
    });

    expect(store.registerClient(["https://client.invalid/callback"])).toBeDefined();
    expect((await fs.stat(dir)).mode & 0o7777).toBe(0o700);
    expect((await fs.stat(file)).mode & 0o7777).toBe(0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// When an existing state directory cannot be made owner-only, the save is
// refused: no state file appears and the directory is left as it was.
it("refuses to save when an existing state directory cannot be made owner-only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-mode-"));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await fs.chmod(root, 0o755);
    const dir = path.join(root, "state");
    await fs.mkdir(dir);
    await fs.chmod(dir, 0o750);
    const file = path.join(dir, "state.json");

    expect(() => storeAt(file).registerClient(["https://client.invalid/callback"])).toThrow(
      "registration_not_persisted"
    );
    expect(logged).toHaveBeenCalledTimes(1);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(dir)).toEqual([]);
    expect((await fs.stat(dir)).mode & 0o7777).toBe(0o750);
  } finally {
    logged.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// The same refusal when a state file is already there: the file keeps its
// bytes and no temporary file is left beside it.
it("leaves an existing state file as it was when its directory cannot be made owner-only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-mode-"));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const dir = path.join(root, "state");
    await fs.mkdir(dir);
    const file = path.join(dir, "state.json");
    const store = storeAt(file);
    expect(store.registerClient(["https://client.invalid/first"])).toBeDefined();
    expect(logged).not.toHaveBeenCalled();
    const before = await fs.readFile(file);

    await fs.chmod(root, 0o755);
    await fs.chmod(dir, 0o750);
    expect(() => store.registerClient(["https://client.invalid/second"])).toThrow("registration_not_persisted");
    expect(logged).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(file)).toEqual(before);
    expect(await fs.readdir(dir)).toEqual(["state.json"]);
    expect((await fs.stat(dir)).mode & 0o7777).toBe(0o750);
  } finally {
    logged.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// The control for the two refusals: a state directory that is already
// owner-only is saved into as it is.
it("saves into an owner-only state directory without changing it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-mode-"));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await fs.chmod(root, 0o755);
    const dir = path.join(root, "state");
    await fs.mkdir(dir);
    await fs.chmod(dir, 0o700);
    const file = path.join(dir, "state.json");

    expect(storeAt(file).registerClient(["https://client.invalid/callback"])).toBeDefined();
    expect(logged).not.toHaveBeenCalled();
    expect((await fs.stat(dir)).mode & 0o7777).toBe(0o700);
    expect((await fs.stat(file)).mode & 0o7777).toBe(0o600);
  } finally {
    logged.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
