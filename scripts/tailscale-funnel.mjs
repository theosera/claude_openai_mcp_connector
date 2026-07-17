import { spawnSync } from "node:child_process";
import { httpPort, loadRepoEnv } from "./repo-env.mjs";

loadRepoEnv();

const action = process.argv[2];
const args = action === "start" ? ["funnel", "--bg", String(httpPort())] : ["funnel", "status"];

if (action !== "start" && action !== "status") {
  throw new Error("Usage: node scripts/tailscale-funnel.mjs <start|status>");
}

const result = spawnSync("tailscale", args, { stdio: "inherit" });
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
