import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { isSystemError, toClientSafeError } from "../src/clientSafeError.js";
import { KnowledgeStore } from "../src/knowledgeStore.js";
import { buildMcpServer } from "../src/server.js";
import { SkillStore } from "../src/skillStore.js";

const UNKNOWN_PATCH_ID = "00000000-0000-4000-8000-000000000000";

async function connect(options: { skills?: boolean } = {}): Promise<{
  client: Client;
  root: string;
  patchStateDir: string;
  store: KnowledgeStore;
  close: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-errleak-vault-"));
  const patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-errleak-patches-"));
  await fs.writeFile(path.join(root, "note.md"), "---\ntitle: Note\n---\n\nbody\n", "utf8");

  const store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
  await store.init();

  let skillStore: SkillStore | undefined;
  if (options.skills) {
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    skillStore = new SkillStore({ knowledgeRoot: root, patchStateDir, skillsSubdir: "skills" });
    await skillStore.init();
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(store, {
    allowWrite: true,
    ...(skillStore ? { allowSkillWrite: true, skillStore } : {})
  });
  await server.connect(serverTransport);
  const client = new Client({ name: "client-safe-error-test", version: "0.0.0" });
  await client.connect(clientTransport);

  return { client, root, patchStateDir, store, close: () => client.close() };
}

async function callToolText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((block) => block.text).join("\n");
}

describe("client-visible errors withhold host filesystem layout", () => {
  it("does not echo the patch-state directory when a patch id is unknown", async () => {
    const { client, patchStateDir, close } = await connect();

    const message = await callToolText(client, "apply_planned_update", { patch_id: UNKNOWN_PATCH_ID });

    expect(message).not.toContain(patchStateDir);
    expect(message).not.toContain(os.homedir());
    expect(message).not.toContain(".json");
    expect(message).toContain("No staged patch with that patch_id");
    await close();
  });

  it("does not echo the patch-state directory for a planned create", async () => {
    const { client, patchStateDir, close } = await connect();

    const message = await callToolText(client, "apply_planned_document_create", {
      patch_id: UNKNOWN_PATCH_ID,
      confirmed_target_path: "note.md"
    });

    expect(message).not.toContain(patchStateDir);
    expect(message).toContain("No staged patch with that patch_id");
    await close();
  });

  it("does not echo the patch-state directory for a planned Skill create", async () => {
    const { client, patchStateDir, close } = await connect({ skills: true });

    const message = await callToolText(client, "apply_planned_skill_create", { patch_id: UNKNOWN_PATCH_ID });

    expect(message).not.toContain(patchStateDir);
    expect(message).toContain("No staged Skill plan with that patch_id");
    await close();
  });

  // The leak the scan's own fix would NOT have closed: this one originates in
  // `fs.realpath` inside resolveForExistingRead, not in a patch read, and it
  // exposes KNOWLEDGE_ROOT rather than the patch-state directory. No per-site
  // catch is involved here — only the boundary keeps it out.
  it("does not echo the vault root when the target disappears between plan and apply", async () => {
    const { client, root, store, close } = await connect();

    const patch = await store.planUpdate({ id_or_path: "note.md", new_body: "changed\n", reason: "test" });
    await fs.rm(path.join(root, "note.md"));

    const message = await callToolText(client, "apply_planned_update", { patch_id: patch.patch_id });

    expect(message).not.toContain(root);
    expect(message).not.toContain(os.homedir());
    expect(message).toContain("The server could not complete a filesystem operation");
    expect(message).toContain("ENOENT");
    await close();
  });

  // The inverse of the guard: messages the server writes itself must survive, or
  // the boundary would be indistinguishable from "all errors are now useless".
  it("passes server-authored messages through unchanged", async () => {
    const { client, root, store, close } = await connect();

    const patch = await store.planUpdate({ id_or_path: "note.md", new_body: "changed\n", reason: "test" });
    await fs.writeFile(path.join(root, "note.md"), "---\ntitle: Note\n---\n\nedited elsewhere\n", "utf8");

    const stale = await callToolText(client, "apply_planned_update", { patch_id: patch.patch_id });
    expect(stale).toContain("Patch is stale");

    const missing = await callToolText(client, "fetch_document", { id_or_path: "absent.md" });
    expect(missing).toContain("Document not found: absent.md");
    await close();
  });
});

describe("system-error classification", () => {
  it("recognizes libuv-shaped errors and rewrites them, keeping only the code", () => {
    const enoent = Object.assign(new Error("ENOENT: no such file or directory, open '/home/someone/secret.json'"), {
      code: "ENOENT",
      errno: -2,
      syscall: "open",
      path: "/home/someone/secret.json"
    });

    expect(isSystemError(enoent)).toBe(true);
    const safe = toClientSafeError(enoent) as Error;
    expect(safe.message).toBe("The server could not complete a filesystem operation (ENOENT).");
    expect(safe.message).not.toContain("/home/someone");
    expect(safe.cause).toBe(enoent);
  });

  it("leaves server-authored errors identical, including protocol errors with a numeric code", () => {
    const authored = new Error("Patch is stale: the target document changed after the plan was created.");
    expect(isSystemError(authored)).toBe(false);
    expect(toClientSafeError(authored)).toBe(authored);

    const protocolError = Object.assign(new Error("Invalid params"), { code: -32602 });
    expect(isSystemError(protocolError)).toBe(false);
    expect(toClientSafeError(protocolError)).toBe(protocolError);
  });
});
