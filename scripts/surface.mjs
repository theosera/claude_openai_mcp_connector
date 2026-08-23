// Declared-vs-live tool-surface comparison, shared by the two operator checks
// (`check-http.mjs` over the HTTP endpoint, `check-stdio.mjs` over a spawned
// stdio server).
//
// It lives here rather than in each script because the write-tool inventory is
// the part that rots: a new write tool added to `src/server.ts` has to appear in
// exactly one list for BOTH checks to keep classifying it, and two copies is how
// one of them quietly stops. The transports differ in how they DECLARE a
// surface (env flags per transport) and not at all in how a live surface is
// judged, so the declaration stays in each script and the judgement is here.

export const GENERAL_WRITE_TOOLS = [
  "plan_document_create",
  "apply_planned_document_create",
  "plan_document_update",
  "apply_planned_update"
];
// Its own category, not part of general write: create_document is the only
// document write with no plan/apply pair, so it takes a second opt-in
// (MCP_ALLOW_LEGACY_CREATE_DOCUMENT) on top of the transport's write flag.
// Folding it back into GENERAL_WRITE_TOOLS would make these checks accept it on
// any write-enabled endpoint — i.e. stop checking the flag that gates it.
export const LEGACY_CREATE_TOOLS = ["create_document"];
export const SKILL_WRITE_TOOLS = ["plan_skill_create", "apply_planned_skill_create"];
export const AUDIT_WRITE_TOOLS = ["append_audit_report", "compare_and_swap_audit_state"];
export const KNOWN_WRITE_TOOLS = new Set([
  ...GENERAL_WRITE_TOOLS,
  ...LEGACY_CREATE_TOOLS,
  ...SKILL_WRITE_TOOLS,
  ...AUDIT_WRITE_TOOLS
]);

/** Per-request/-handshake timeout for both checks (MCP_CHECK_TIMEOUT_MS). */
export function checkTimeoutMs(env = process.env) {
  const raw = env.MCP_CHECK_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 10000;
}

/**
 * Compare a LIVE `tools/list` result against what a transport's flags declare.
 *
 * `categories` is `[{ key, tools, declared }]`. A surface WIDER than declared —
 * a known write tool whose category is off, or an unrecognized write-capable
 * tool nobody classified — is a failure. NARROWER (declared on, tool absent) is
 * a warning: narrower never widens the security surface.
 */
export function classifySurface(tools, categories) {
  const names = new Set(tools.map((tool) => tool.name));
  const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).length;

  // The set of write tools the flags actually permit. Anything write-capable
  // outside this set fails closed.
  const permittedWriteTools = new Set(categories.filter((category) => category.declared).flatMap((c) => c.tools));
  const writeCapable = tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name);
  const unexpected = writeCapable.filter((name) => !permittedWriteTools.has(name));

  const failures = [];
  const warnings = [];
  if (unexpected.length > 0) {
    const unclassified = unexpected.filter((name) => !KNOWN_WRITE_TOOLS.has(name));
    const suffix = unclassified.length > 0 ? ` (unclassified/unknown: ${unclassified.join(", ")})` : "";
    failures.push(
      `WIDER than declared — write-capable tools not permitted by flags: ${unexpected.join(", ")}${suffix}`
    );
  }
  for (const category of categories) {
    if (category.declared && !category.tools.some((name) => names.has(name))) {
      warnings.push(`${category.key}: declared ON but no tool present (narrower than declared).`);
    }
  }

  return { readOnly, writeCapable, failures, warnings };
}
