---
name: mcp-vault-security
description: claude_openai_mcp_connector (private Markdown vault を MCP で公開する stdio/HTTP サーバ) のセキュリティ不変条件と「コードのどこ」対応表。path containment / frontmatter allowlist / two-step stale-safe update / exact-path create の保存先確認 / constrained Skill bundle creation / constrained audit write surface (append+CAS・監査サブツリー予約) / public-repo 安全 / untrusted vault content。**`src/pathSafety.ts` / `src/knowledgeStore.ts` / `src/skillStore.ts` / `src/auditStore.ts` / `src/multiRootStore.ts` / `src/frontmatter.ts` / `src/config.ts` / 新しい MCP tool / 対応 tests を書く・直す・レビューする前に必ずこの Skill をロードしてから**着手せよ。
# allowed-tools は Read のみ事前承認 (本 skill + 対象コードの読取用)。これは「事前承認の
# 最小化」であって他ツールの禁止ではない — 未列挙の Edit/Bash 等はセッション通常の
# permission に従い都度承認で使える。
allowed-tools: Read
---

# mcp-vault-security（目次）

本文は節ごとに `references/` の下へ分けてある。分けた時点（#347）の中身は分ける前の SKILL.md と同じで、言い換えていない（その時点では、元の順に連ねると元の本文と全 byte で一致した）。その後の直しは各ファイルに入っているので、今は一致しない。

⛔ **全部を一度に読まない。触るファイルに当たる節だけを読む。**

## 目次

| ファイル | 節（元の見出し） | 大きさ |
|---|---|---|
| `references/00-intro.md` | 冒頭（最初の `## ` より前） | 519 B |
| `references/01-inv-1-path-containment.md` | 不変条件 (invariants — 弱めない) ＞ INV-1 Path containment — 全アクセスは KNOWLEDGE_ROOT 配下 | 5,114 B |
| `references/01-inv-2-frontmatter-allowlist.md` | 不変条件 ＞ INV-2 Frontmatter field allowlist — YAML injection 防止 | 6,867 B |
| `references/01-inv-3-stale-safe-write.md` | 不変条件 ＞ INV-3 Two-step stale-safe write | 4,655 B |
| `references/01-inv-4-public-private-separation.md` | 不変条件 ＞ INV-4 Public repo / private vault 分離 | 397 B |
| `references/01-inv-5-untrusted-vault-content.md` | 不変条件 ＞ INV-5 Untrusted vault content (prompt injection) | 920 B |
| `references/01-inv-6-remote-http-transport.md` | 不変条件 ＞ INV-6 Remote HTTP transport — authn + 露出最小化 (fail-closed) | 4,979 B |
| `references/01-inv-7-oauth-authorization-server.md` | 不変条件 ＞ INV-7 OAuth 2.1 authorization server (web client 用 / opt-in) | 8,995 B |
| `references/01-inv-8-skill-bundle-creation.md` | 不変条件 ＞ INV-8 Constrained Skill bundle creation | 3,912 B |
| `references/01-inv-9-audit-write-surface.md` | 不変条件 ＞ INV-9 Constrained audit write surface (監査証跡の完全性) | 9,898 B |
| `references/02-code-map.md` | コードのどこ (file → 不変条件) | 44,000 B |
| `references/03-tests.md` | テストで固定する (規約でなく実行可能な保証) | 16,564 B |
| `references/04-pre-commit-review.md` | pre-commit レビューの発火 (CLAUDE.md 発火表の詳細) | 3,256 B |
| `references/05-references.md` | 参考 | 227 B |

`## 不変条件` の見出しの行は INV-1 のファイルの頭にある。

## どのファイルを触るときにどの節を読むか

対象のファイルは `CLAUDE.md` の発火表で `mcp-vault-security` の行の 1 列目に並ぶもの（`src/pathSafety.ts`・`src/knowledgeStore.ts`・`src/skillStore.ts`・`src/auditStore.ts`・`src/multiRootStore.ts`・`src/frontmatter.ts`・`src/config.ts`・`src/initEnv.ts`・`src/index.ts` と `src/server.ts` の新しい MCP tool・`src/httpServer.ts`・`src/webBridge.ts`・`src/httpAuth.ts`・`src/oauth/*.ts` と、それぞれのテスト）。

| するとき | 読む節 |
|---|---|
| 上のファイルを書く・直す・レビューする | ① `references/02-code-map.md` で、そのファイルの行だけを引く（1 つの表なので、全体を読まずにファイルの名で検索して当たる行を読む）② その行に挙がる INV の `references/01-inv-*.md` だけを読む |
| どの INV に当たるか分かっているとき | 目次からその INV のファイルを直接読む |
| テストを足す・直す（上のファイルのテスト） | `references/03-tests.md` と、当たる INV のファイル |
| commit の前のレビュー（発火するか・どう回すか） | `references/04-pre-commit-review.md` |
| この skill の前提を確かめる | `references/00-intro.md` |

⚠️ どのファイルがどの INV に当たるかの正は `references/02-code-map.md` の行。この目次では決めない。
