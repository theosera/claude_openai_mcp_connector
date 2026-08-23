// Declared-vs-live surface check for the STDIO transport — the counterpart to
// check-http.mjs (GAP-5: HTTP had one, stdio had none).
//
// For each endpoint (identified by an `.env` file) it SPAWNS THE REAL
// ENTRYPOINT the way an MCP client does, runs the handshake over stdin/stdout
// (initialize -> notifications/initialized -> tools/list), and compares the LIVE
// tool surface with what that file's flags DECLARE.
//
// ★ It reads `tools/list`, never the server's startup line. That is the whole
// design constraint, not a stylistic choice: the startup line is the server's
// own CLAIM about its surface, and #113 measured the two disagreeing —
// restoring the Skill gate turned one wire test red and left the startup-line
// test green. A check built on the claim would reproduce the gap it exists to
// close. The child's stderr is captured for DIAGNOSTICS only (printed on
// failure) and never parsed into a verdict.
//
// What stdio declares, and why it differs from HTTP:
//   general document write  ALWAYS on — stdio is the full surface by design
//                           (src/index.ts passes allowWrite: true).
//   legacy create_document  MCP_ALLOW_LEGACY_CREATE_DOCUMENT (off by default).
//   skill write             MCP_STDIO_ALLOW_SKILL_WRITE + MCP_SKILLS_SUBDIR.
//   audit write             MCP_STDIO_ALLOW_AUDIT_WRITE + MCP_AUDIT_SUBDIR.
// The two subdir variables also RESERVE their subtrees (INV-8 / INV-9) whether
// or not the tools are registered; this check is about the registered surface,
// so it reports the reservation separately rather than folding it in.
//
// Exit status:
//   0  the server started, answered, AND no surface WIDER than its declared flags
//   1  a live surface is WIDER than declared (a security regression — e.g. an
//      interactive session exposing the audit write tools, or an unrecognized
//      write-capable tool not permitted by any enabled category), or the server
//      failed to start / answer within the timeout.
//
// A surface NARROWER than declared (a flag on but the tool missing) is a
// WARNING, not a failure: narrower never widens the security surface.
//
// Usage:
//   node scripts/check-stdio.mjs [--env <path>]... [--entry <path>]
//   pnpm run check:stdio -- --env ./.env
// With no --env, a single ./.env is checked. --entry defaults to dist/index.js
// (run `pnpm build` first); a `.ts` entry is run through the local tsx loader so
// a development checkout can be checked without building.
// MCP_CHECK_TIMEOUT_MS (default 10000) bounds the handshake.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseEnvFile, isTruthy, repoRoot } from "./repo-env.mjs";
import {
  AUDIT_WRITE_TOOLS,
  GENERAL_WRITE_TOOLS,
  LEGACY_CREATE_TOOLS,
  SKILL_WRITE_TOOLS,
  checkTimeoutMs,
  classifySurface
} from "./surface.mjs";

const TIMEOUT_MS = checkTimeoutMs();
const DEFAULT_ENTRY = path.join(repoRoot, "dist", "index.js");

const USAGE = `Usage: node scripts/check-stdio.mjs [--env <path>]... [--entry <path>]

Spawns the real entrypoint per endpoint, runs the MCP handshake over stdio and
verifies the live tool surface against that endpoint's flags. Defaults to ./.env
and dist/index.js. MCP_CHECK_TIMEOUT_MS (default 10000) bounds the handshake.`;

function parseArgs(argv) {
  const envPaths = [];
  let entry = DEFAULT_ENTRY;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--env") {
      const value = argv[++i];
      if (!value) throw new Error("--env requires a path argument.");
      envPaths.push(value);
    } else if (arg === "--entry") {
      const value = argv[++i];
      if (!value) throw new Error("--entry requires a path argument.");
      entry = path.resolve(value);
    } else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  if (envPaths.length === 0) envPaths.push(path.join(repoRoot, ".env"));
  return { envPaths, entry };
}

/** Node arguments needed to run `entry`, plus the entry itself. */
function childArgs(entry) {
  if (!fs.existsSync(entry)) {
    throw new Error(`Missing entrypoint: ${entry} (run \`pnpm build\`, or pass --entry <path>).`);
  }
  if (!entry.endsWith(".ts")) return [entry];
  // A TypeScript entry (a development checkout) is loaded through the tsx
  // loader — the same one tests/stdio.test.ts spawns it with — so the check runs
  // the real entrypoint rather than a transpiled copy that could drift from it.
  // Resolved through the module graph rather than by joining a path onto
  // repoRoot: in a git worktree the installed tree lives beside the main
  // checkout, and a literal `<repoRoot>/node_modules` is simply absent there.
  let loader;
  try {
    loader = import.meta.resolve("tsx/esm");
  } catch {
    throw new Error(`--entry ${entry} is TypeScript but tsx is not installed (run \`pnpm install\`, or build first).`);
  }
  return ["--import", loader, entry];
}

/**
 * The child's environment.
 *
 * Built from the endpoint's own file plus a minimal base rather than inherited
 * wholesale, for the reason repo-env.mjs already gives for `dotenv.parse`: the
 * declared half of this comparison comes from that file, so the live half has to
 * come from the same place or the check is comparing two different
 * configurations. An `MCP_*` variable in the caller's shell would do exactly
 * that. `MCP_TRANSPORT` is forced because this check is about the stdio surface.
 */
function childEnv(fileEnv) {
  const base = {};
  for (const name of ["PATH", "HOME", "LANG", "TMPDIR", "NODE_OPTIONS"]) {
    if (process.env[name] !== undefined) base[name] = process.env[name];
  }
  return { ...base, ...fileEnv, MCP_TRANSPORT: "stdio" };
}

/**
 * Run the handshake against a freshly spawned server and return its tools.
 *
 * MCP's stdio framing is newline-delimited JSON-RPC, so each message is one
 * line on the child's stdin and replies arrive as lines on its stdout.
 */
function handshake(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error(`no tools/list response within ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    function finish(error, tools) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (error) {
        // stderr is diagnostic ONLY — it is never read for the verdict. It is
        // the only place a startup refusal (a bad KNOWLEDGE_ROOT, a flag whose
        // subdir is missing) explains itself, so a failure prints its tail.
        const tail = stderr.trim().split(/\r?\n/).slice(-4).join(" | ").slice(0, 500);
        reject(new Error(tail ? `${error.message} — server stderr: ${tail}` : error.message));
      } else {
        resolve(tools);
      }
    }

    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(new Error(`server exited (code ${code}) before answering tools/list`)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch {
          continue; // not protocol data; ignore rather than fail the check
        }
        if (message.id === 1) {
          if (message.error) {
            finish(new Error(`initialize failed: ${JSON.stringify(message.error)}`));
            return;
          }
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (message.id === 2) {
          if (message.error) {
            finish(new Error(`tools/list failed: ${JSON.stringify(message.error)}`));
            return;
          }
          const tools = message.result?.tools;
          if (!Array.isArray(tools)) {
            finish(new Error("tools/list returned no tools array."));
            return;
          }
          finish(undefined, tools);
          return;
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "repo-stdio-check", version: "1" }
      }
    });
  });
}

async function checkEndpoint(envPath, entry) {
  const { resolved, env } = parseEnvFile(envPath);
  const args = childArgs(entry);
  const tools = await handshake(process.execPath, args, childEnv(env));

  const skillsSubdir = Boolean(env.MCP_SKILLS_SUBDIR?.trim());
  const auditSubdir = Boolean(env.MCP_AUDIT_SUBDIR?.trim());
  const declared = {
    // Not a flag: src/index.ts serves the full document write surface on stdio.
    // Declared ON so that its ABSENCE warns (narrower) instead of passing
    // silently, and so an added tool still has to fall in some category.
    generalWrite: true,
    legacyCreate: isTruthy(env.MCP_ALLOW_LEGACY_CREATE_DOCUMENT),
    // Both halves, because both are required to register the tools — reporting
    // the flag alone would declare a surface the server does not serve.
    skillWrite: isTruthy(env.MCP_STDIO_ALLOW_SKILL_WRITE) && skillsSubdir,
    auditWrite: isTruthy(env.MCP_STDIO_ALLOW_AUDIT_WRITE) && auditSubdir
  };
  const categories = [
    { key: "general document write", tools: GENERAL_WRITE_TOOLS, declared: declared.generalWrite },
    { key: "legacy create_document", tools: LEGACY_CREATE_TOOLS, declared: declared.legacyCreate },
    { key: "skill write", tools: SKILL_WRITE_TOOLS, declared: declared.skillWrite },
    { key: "audit write", tools: AUDIT_WRITE_TOOLS, declared: declared.auditWrite }
  ];

  const { readOnly, writeCapable, failures, warnings } = classifySurface(tools, categories);
  return {
    envPath: resolved,
    entry,
    toolCount: tools.length,
    readOnly,
    writeCapable: writeCapable.length,
    declared,
    // Reported, not judged: the subtree reservations hold whether or not the
    // write tools are registered, and an operator comparing two processes needs
    // to see the three states INV-9 distinguishes (off / reserved-only / on).
    reservations: {
      skills: !skillsSubdir ? "off" : declared.skillWrite ? "on" : "reserved-only",
      audit: !auditSubdir ? "off" : declared.auditWrite ? "on" : "reserved-only"
    },
    failures,
    warnings
  };
}

const { envPaths, entry } = parseArgs(process.argv.slice(2));
let hadFailure = false;

for (const envPath of envPaths) {
  console.log(`\n== ${envPath} ==`);
  try {
    const r = await checkEndpoint(envPath, entry);
    console.log(`  entry:    ${r.entry}`);
    console.log(
      `  declared: documents=on legacy_create=${r.declared.legacyCreate ? "on" : "off"} ` +
        `skills=${r.reservations.skills} audit=${r.reservations.audit}`
    );
    console.log(`  tools:    ${r.toolCount} (${r.readOnly} read-only, ${r.writeCapable} write-capable)`);
    for (const warning of r.warnings) console.log(`  WARN:     ${warning}`);
    if (r.failures.length === 0) {
      console.log("  RESULT:   OK — live surface matches declared flags (not wider).");
    } else {
      hadFailure = true;
      for (const failure of r.failures) console.log(`  FAIL:     ${failure}`);
    }
  } catch (error) {
    hadFailure = true;
    console.log(`  FAIL:     ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("");
if (hadFailure) {
  console.log("check:stdio FAILED — see FAIL lines above.");
  process.exitCode = 1;
} else {
  console.log(`check:stdio OK — ${envPaths.length} endpoint(s) verified.`);
}
