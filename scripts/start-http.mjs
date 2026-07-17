import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRepoEnv, repoRoot } from "./repo-env.mjs";

loadRepoEnv();
process.env.MCP_TRANSPORT = "http";
process.chdir(repoRoot);

const entrypoint = path.join(repoRoot, "dist", "index.js");
if (!fs.existsSync(entrypoint)) {
  throw new Error(`Missing ${entrypoint}. Run "pnpm run build" first.`);
}

await import(pathToFileURL(entrypoint).href);
