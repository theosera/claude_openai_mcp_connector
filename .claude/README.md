# .claude/

Claude Code (本リポの AI 開発エージェント) がセッション開始時に自動ロードする
project-level 設定。3層設計の一部 — グローバル層 (`~/.claude/CLAUDE.md` 用の
`CLAUDE.global.md`) と repo 層 (`./CLAUDE.md`) の下で、**詳細な作業規約・機能知識を
発火条件付きでオンデマンドにロード**する (トークン削減)。

## skills/

project-level スキル (`<name>/SKILL.md`)。ディレクトリ名がスキル名になる。
`description` のトリガ文 + 親 `CLAUDE.md` の**スキル発火表**で発火する。**フラット固定**
(中間カテゴリディレクトリで機能グループ化しない — Claude Code の nested 検出は既知の
不具合 #28266/#40640/#39138 で信頼できず、発火の決定論性を損なうため)。

| スキル | 発火条件 | 用途 |
|---|---|---|
| `mcp-vault-security` | MCP のセキュリティ境界コード (`src/pathSafety.ts` / `src/knowledgeStore.ts` / `src/frontmatter.ts` / `src/config.ts` / `src/index.ts` の新 tool / `tests/pathSafety.test.ts`) を書く/直す/レビューする前 | path containment / frontmatter allowlist / two-step write / public-repo 安全 / untrusted content の不変条件 + 「コードのどこ」対応表 |

## settings.json

**全コラボレータに共有される設定** (git commit する)。

### permissions.deny の意図
Secrets 漏洩防止 — `.env` / `credentials*.json` / `service-account*.json` /
`*token*.json` / `*.key` / `*.pem` / `id_rsa` / `id_ed25519` / `secrets.{json,yaml,yml}`
を Claude (自分自身) が **Read / Bash (`cat`/`head`/`tail`/`less`/`more`/`grep`/`awk`/`sed`)
経由で読まない**よう物理ブロックする。`.gitignore` (commit 段階) と本ファイル (read 段階)
の二重防御。

### deny は allow に勝つ
Claude Code の permission 評価は **deny 優先**。誤って読もうとしても approval ダイアログ
無しで即拒否され、安全側に倒れる。

## settings.local.json (gitignore 対象)
個人マシン固有の上書き (例: ローカルの `KNOWLEDGE_ROOT` や vault path)。**commit しない**。

## 関連
- `../CLAUDE.md` — repo 固有ハードルール + スキル発火表
- `../CLAUDE.global.md` — 全リポ共通グローバル層 (byte-identical)
- `../SECURITY.md` — 脅威モデル + Reusable Security Baseline 対応表
