import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  knowledgeRoot: string;
  writeMode: "two_step";
  patchStateDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const knowledgeRoot = env.KNOWLEDGE_ROOT?.trim();
  if (!knowledgeRoot) {
    throw new Error("KNOWLEDGE_ROOT is required. Point it at your private Markdown vault clone.");
  }

  const writeMode = env.MCP_WRITE_MODE?.trim() || "two_step";
  if (writeMode !== "two_step") {
    throw new Error("Only MCP_WRITE_MODE=two_step is supported for existing document edits.");
  }

  return {
    knowledgeRoot: path.resolve(knowledgeRoot),
    writeMode,
    patchStateDir: path.resolve(env.MCP_PATCH_STATE_DIR?.trim() || ".mcp-state/patches")
  };
}
