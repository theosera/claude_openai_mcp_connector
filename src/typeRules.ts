/**
 * Opt-in document-type weighting for the context packer (D-7).
 *
 * Ranking that trusts a note's own claim about itself is a ranking-injection
 * path: a web clipping that lands in the vault can declare `type: permanent`
 * and promote itself past the notes the owner actually wrote. This module
 * exists to make the weighting possible WITHOUT opening that path, so the split
 * it enforces matters more than the arithmetic:
 *
 * | signal | who owns it | ceiling |
 * | --- | --- | --- |
 * | `root` name | configuration | unbounded |
 * | `path_prefix` | the filesystem | unbounded |
 * | `tag` | frontmatter — the note itself | `MAX_SELF_DECLARED_WEIGHT` |
 * | frontmatter `type` hint | the note itself | `MAX_SELF_DECLARED_WEIGHT`, and off by default |
 *
 * ⚠️ **`tags` belongs on the lower half of that table even though it looks like
 * metadata rather than content.** It is frontmatter, so a clipping can carry
 * it, and it is one of the five keys INV-2's patch allowlist already lets an
 * MCP client write — so a tag is reachable both by importing a note and by
 * calling `plan_document_update`. Treating it as owner-controlled would hand
 * back exactly what the ceiling is for.
 *
 * ⚠️ **`type` is deliberately NOT added to that patch allowlist.** Setting a
 * document's type stays a human edit in Obsidian, which is what keeps knowledge
 * promotion human-in-the-loop without a `promote_knowledge` write tool.
 *
 * Unset (`MCP_CONTEXT_TYPE_RULES` absent) means every document weighs 1.0 and
 * carries no type — byte-identical ranking to not having this module at all,
 * the same opt-in posture the audit surface set.
 */

import type { MarkdownDocument } from "./types.js";

/**
 * The most a note's own claims about itself may be worth.
 *
 * Not "no weight at all": a vault whose owner tags syntheses genuinely does
 * carry signal there, and refusing it entirely would push operators toward
 * encoding the same thing in a path they then have to maintain. A ceiling keeps
 * the signal usable while making it unable to outrank a directory the owner
 * chose.
 */
export const MAX_SELF_DECLARED_WEIGHT = 1.25;

/** Weight applied when nothing matches, and the weight of every document when
 *  no rules file is configured. */
export const DEFAULT_TYPE_WEIGHT = 1.0;

/** Hard bound on any weight, self-declared or not. Keeps a typo in a rules file
 *  from turning one directory into the entire answer. */
export const MAX_TYPE_WEIGHT = 3.0;

/** Rule count cap. A rules file is owner-authored, but it is still parsed input. */
export const MAX_TYPE_RULES = 64;

interface RuleMatch {
  path_prefix?: string;
  root?: string;
  tag?: string;
}

export interface TypeRule {
  name: string;
  match: RuleMatch;
  weight: number;
  /** True when the rule matched on a signal the note can author about itself,
   *  which is what caps its weight. */
  selfDeclared: boolean;
}

export interface TypeRules {
  rules: TypeRule[];
  frontmatterTypeHint: { enabled: boolean; maxWeight: number };
}

export interface TypeVerdict {
  /** The rule's `name`, or the frontmatter type when the hint supplied it. */
  type?: string;
  weight: number;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number`);
  }
  return value;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string when present`);
  }
  return value;
}

/**
 * Parse and validate a rules document.
 *
 * The clamp is applied HERE, at parse time, rather than at scoring time, so the
 * loaded rules are already safe and no later caller has to remember. A rules
 * file asking for more than a self-declared signal may carry is not an error —
 * it is clamped, and the clamped value is what the server then uses — because
 * failing to boot over a ranking preference would cost availability to enforce
 * a bound that clamping already enforces.
 */
export function parseTypeRules(raw: unknown): TypeRules {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("type rules must be a JSON object");
  }
  const source = raw as Record<string, unknown>;
  const rawRules = source.rules;
  if (!Array.isArray(rawRules)) {
    throw new Error('type rules must carry a "rules" array');
  }
  if (rawRules.length > MAX_TYPE_RULES) {
    throw new Error(`type rules may declare at most ${MAX_TYPE_RULES} rules`);
  }

  const rules = rawRules.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`rules[${index}] must be an object`);
    }
    const rule = entry as Record<string, unknown>;
    const name = asOptionalString(rule.name, `rules[${index}].name`);
    if (name === undefined) {
      throw new Error(`rules[${index}].name is required`);
    }
    if (typeof rule.match !== "object" || rule.match === null || Array.isArray(rule.match)) {
      throw new Error(`rules[${index}].match must be an object`);
    }
    const rawMatch = rule.match as Record<string, unknown>;
    const match: RuleMatch = {
      path_prefix: asOptionalString(rawMatch.path_prefix, `rules[${index}].match.path_prefix`),
      root: asOptionalString(rawMatch.root, `rules[${index}].match.root`),
      tag: asOptionalString(rawMatch.tag, `rules[${index}].match.tag`)
    };
    if (match.path_prefix === undefined && match.root === undefined && match.tag === undefined) {
      throw new Error(`rules[${index}].match needs at least one of path_prefix, root, tag`);
    }
    // A rule that matches on a tag AT ALL is self-declared, even when it also
    // names a path: the tag half is what the note controls, and a rule is only
    // as trustworthy as the weakest signal it consults.
    const selfDeclared = match.tag !== undefined;
    const requested = asNumber(rule.weight, `rules[${index}].weight`);
    const ceiling = selfDeclared ? MAX_SELF_DECLARED_WEIGHT : MAX_TYPE_WEIGHT;
    return { name, match, weight: Math.min(requested, ceiling), selfDeclared };
  });

  const hint = source.frontmatter_type_hint;
  let frontmatterTypeHint = { enabled: false, maxWeight: MAX_SELF_DECLARED_WEIGHT };
  if (hint !== undefined) {
    if (typeof hint !== "object" || hint === null || Array.isArray(hint)) {
      throw new Error("frontmatter_type_hint must be an object");
    }
    const rawHint = hint as Record<string, unknown>;
    const enabled = rawHint.enabled === true;
    const maxWeight =
      rawHint.max_weight === undefined
        ? MAX_SELF_DECLARED_WEIGHT
        : Math.min(asNumber(rawHint.max_weight, "frontmatter_type_hint.max_weight"), MAX_SELF_DECLARED_WEIGHT);
    frontmatterTypeHint = { enabled, maxWeight };
  }

  return { rules, frontmatterTypeHint };
}

/** The document's path within its own root — rules are written against vault
 *  layout, not against the `<root>:` handle the composite hands out. */
function localPathOf(document: MarkdownDocument): string {
  if (!document.root) {
    return document.relativePath;
  }
  const separator = document.relativePath.indexOf(":");
  return separator >= 0 ? document.relativePath.slice(separator + 1) : document.relativePath;
}

function matches(rule: TypeRule, document: MarkdownDocument, localPath: string): boolean {
  if (rule.match.root !== undefined && document.root !== rule.match.root) {
    return false;
  }
  if (rule.match.path_prefix !== undefined && !localPath.startsWith(rule.match.path_prefix)) {
    return false;
  }
  if (rule.match.tag !== undefined) {
    const tags = document.frontmatter.tags;
    if (!Array.isArray(tags) || !tags.includes(rule.match.tag)) {
      return false;
    }
  }
  return true;
}

/**
 * Weight one document. First rule that matches wins — order in the file is the
 * operator's priority statement, and scanning for "the best match" would make
 * the file's meaning depend on the weights it contains.
 */
export function weighDocument(rules: TypeRules | undefined, document: MarkdownDocument): TypeVerdict {
  if (!rules) {
    return { weight: DEFAULT_TYPE_WEIGHT };
  }
  const localPath = localPathOf(document);
  for (const rule of rules.rules) {
    if (matches(rule, document, localPath)) {
      return { type: rule.name, weight: rule.weight };
    }
  }

  // The hint is last and capped: it is the note speaking about itself, so it
  // can only ever break a tie between documents no owner-controlled rule
  // distinguished.
  if (rules.frontmatterTypeHint.enabled) {
    const declared = document.frontmatter.type;
    if (typeof declared === "string" && declared.length > 0) {
      return { type: declared, weight: rules.frontmatterTypeHint.maxWeight };
    }
  }

  return { weight: DEFAULT_TYPE_WEIGHT };
}
