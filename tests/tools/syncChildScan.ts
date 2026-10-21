import ts from "typescript";

/**
 * The static check behind tests/syncChildTimeout.test.ts: find every synchronous
 * child-process call in a source file and say whether it has a runaway cap.
 *
 * The file is parsed with the TypeScript compiler, so a name inside a string, a
 * template, a comment or a regular expression is never taken for a call. A call
 * is found by name: the three APIs, any alias or namespace imported from
 * child_process, and any `.execFileSync(` / `.spawnSync(` / `.execSync(` on an
 * object (which covers a namespace or default import). The check leans closed:
 * options must be an object literal with a final known timeout definition: a
 * later spread may override it, and an unresolved computed key is never accepted.
 * Any `require` or dynamic `import` of child_process also counts as unsupported,
 * since the check does not follow its bindings.
 */

export const SYNC_APIS = ["execFileSync", "spawnSync", "execSync"] as const;
type SyncApi = (typeof SYNC_APIS)[number];
const isSyncApi = (name: string): name is SyncApi => (SYNC_APIS as readonly string[]).includes(name);
const isChildProcess = (spec: string) => spec === "child_process" || spec === "node:child_process";

export type SyncCall = { line: number; api: SyncApi; capped: boolean; why: string };
/** `bounded` counts calls to the helpers in tests/tools/syncChild.ts, so a check can see it reached them. */
export type FileScan = { calls: SyncCall[]; loads: number[]; bounded: number };

const BOUNDED = new Set(["execFileSyncBounded", "spawnSyncBounded"]);

export function scanSource(fileName: string, text: string): FileScan {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const aliases = new Map<string, SyncApi>(SYNC_APIS.map((api) => [api, api]));
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!isChildProcess(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (isSyncApi(imported)) aliases.set(element.name.text, imported);
      }
    }
  }
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const calls: SyncCall[] = [];
  const loads: number[] = [];
  let bounded = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      const loader =
        (ts.isIdentifier(callee) && callee.text === "require") || callee.kind === ts.SyntaxKind.ImportKeyword;
      if (loader && first && ts.isStringLiteralLike(first) && isChildProcess(first.text)) loads.push(lineOf(node));
      let api: SyncApi | undefined;
      if (ts.isIdentifier(callee)) api = aliases.get(callee.text);
      else if (ts.isPropertyAccessExpression(callee) && isSyncApi(callee.name.text)) api = callee.name.text;
      if (api) calls.push({ line: lineOf(node), api, ...capOf(api, node.arguments) });
      if (ts.isIdentifier(callee) && BOUNDED.has(callee.text)) bounded++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { calls, loads, bounded };
}

function capOf(api: SyncApi, args: ts.NodeArray<ts.Expression>): { capped: boolean; why: string } {
  const options =
    api === "execSync"
      ? args[1]
      : args.length >= 3
        ? args[2]
        : args[1] && !ts.isArrayLiteralExpression(args[1])
          ? args[1]
          : undefined;
  if (options === undefined) return { capped: false, why: "it passes no options" };
  if (!ts.isObjectLiteralExpression(options)) return { capped: false, why: "its options are not an object literal" };
  if (
    options.properties.some(
      (p) => !ts.isSpreadAssignment(p) && ts.isComputedPropertyName(p.name) && propertyName(p.name) === undefined
    )
  ) {
    return { capped: false, why: "its options have an unresolved computed property name" };
  }
  let own: ts.ObjectLiteralElementLike | undefined;
  let spread = false;
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      own = undefined;
      spread = true;
    } else if (namesTimeout(property)) {
      own = property;
      spread = false;
    }
  }
  if (
    own &&
    ts.isPropertyAssignment(own) &&
    ts.isNumericLiteral(own.initializer) &&
    Number(own.initializer.text) === 0
  ) {
    return { capped: false, why: "its options set timeout to 0, which Node treats as no limit" };
  }
  if (own) {
    return ts.isPropertyAssignment(own) || ts.isShorthandPropertyAssignment(own)
      ? { capped: true, why: "its options name a timeout" }
      : { capped: false, why: "its options define timeout as a method or accessor" };
  }
  if (spread) {
    return { capped: false, why: "its options spread another object, which may hide the timeout" };
  }
  if (nestedTimeout(options)) return { capped: false, why: "its options name a timeout only inside a nested value" };
  return { capped: false, why: "its options name no timeout" };
}

function namesTimeout(p: ts.Node): boolean {
  return (
    (ts.isPropertyAssignment(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p)) &&
    propertyName(p.name) === "timeout"
  );
}

/** Resolve syntax-level keys only; an identifier inside `[...]` is a value, not its spelling. */
function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    let expression = name.expression;
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return expression.text;
  }
  return undefined;
}

/** Whether a property named `timeout` sits anywhere below the options' own level. */
function nestedTimeout(options: ts.ObjectLiteralExpression): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (namesTimeout(node)) found = true;
    else ts.forEachChild(node, visit);
  };
  for (const p of options.properties) ts.forEachChild(p, visit);
  return found;
}
