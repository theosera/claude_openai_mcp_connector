# PR/FAQ — claude_openai_mcp_connector

> Amazon の "Working Backwards" 形式の社内 PR/FAQ。製品を顧客起点で語り、難所を
> FAQ で詰めるための文書。公開広報ではなく企画・意思決定のための生きた文書として
> 扱い、製品の変化に合わせて更新する。

---

## Press Release

### タイトル
**Obsidian / Markdown の個人知識を、複数の AI クライアントから安全に使えるようにする ―― claude_openai_mcp_connector v0.1.0 公開**

### サブタイトル
AI ごとに同じ文脈を貼り直す手間を解消。private vault を公開せず、read-only 既定・OAuth・path 封じ込めで「個人知識 × AI」を安全につなぐ MCP ゲートウェイ。

### 本文

本日、**claude_openai_mcp_connector v0.1.0** を公開しました。このツールにより、Obsidian や Markdown Vault に蓄積した個人知識を、**Claude Code・Claude Desktop・ChatGPT・Codex** など複数の AI クライアントから安全に検索・参照できるようになります。

従来、ユーザーは AI ごとに同じ文脈を貼り直す必要がありました。本製品は、private vault を公開せず、**read-only default・OAuth scope・audience binding・path traversal 対策**を備えた **MCP ゲートウェイ**として、個人知識と AI エージェントを安全につなぎます。

- **誰向けか** — Obsidian / Markdown でナレッジを育てており、「データを丸ごとクラウドに預けたくない」個人・研究者・小規模チーム。
- **何の問題を解決するか** — AI ごとの文脈コピペの反復と陳腐化、そして「全文アップロードへの不安」。手元の vault を**必要なときに必要な分だけ**渡す。
- **どう使うか** — リポジトリを clone し `KNOWLEDGE_ROOT` を自分の vault に向けて起動。ローカルは stdio で直結、web は OAuth + HTTPS で接続。
- **なぜ安全か** — 既定 read-only、編集は二段階承認＋ stale 保護、全アクセスを `KNOWLEDGE_ROOT` 配下に封じ込め、web は OAuth 2.1（PKCE・audience/scope バインド）。
- **何が従来と違うか** — 「コードは公開・ノートは非公開」を設計の核に、Markdown ナレッジ特化＋セキュリティ既定値を厳格化。SaaS への丸ごと取り込みでも、汎用ファイル共有でもない中間解。

### 顧客コメント
「Obsidian の数千ノートを ChatGPT からも Claude からも検索できるのに、vault はずっと自分のマシンの中。書き込みは二段階承認だから、AI が勝手にノートを壊す心配もない。AI を変えても“貼り直し”がもう要らないのが一番うれしい」――個人研究者

---

## FAQ

### 顧客向け FAQ

**Q. これは何ですか？**
Obsidian / Markdown の個人知識ベースを、AI クライアントから検索・参照（必要に応じて編集）できるようにする MCP サーバです。vault を公開せず、手元に置いたまま AI に橋渡しします。

**Q. 誰向けですか？**
Markdown でナレッジを蓄積していて、プライバシーを理由に AI 連携をためらってきた個人・研究者・小規模チーム向けです。

**Q. 何が便利ですか？**
AI ごとに同じ背景をコピペし直す必要がなくなります。Claude Code・Claude Desktop・ChatGPT・Codex のどれからでも、同じ vault を同じように参照できます。

**Q. 既存ツールと何が違いますか？**
(1) ノートを SaaS に丸ごと取り込む方式と違い、**データは手元のまま**。(2) 汎用ファイル共有と違い、**Markdown ナレッジに特化**（frontmatter・projects・source refs・backlink）し、**セキュリティ既定値が厳格**（read-only 既定・二段階書き込み・path 封じ込め・OAuth audience/scope バインド）です。

### 技術 FAQ

**Q. どう接続しますか？**
2 つの transport を持ちます。ローカル CLI/デスクトップ（Claude Code・Codex・Claude Desktop）は **stdio で直結**。ChatGPT・Claude.ai の web は **HTTP エンドポイント（`/mcp`）に HTTPS 経由**で接続します。

**Q. 認証はどうなっていますか？**
HTTP は認証必須（fail-closed）。Claude Desktop / Claude Code（remote）/ Claude API は**静的 bearer**（`MCP_AUTH_TOKEN`）。ChatGPT・Claude.ai web は静的 bearer を受け付けないため、内蔵の **OAuth 2.1 認可サーバ**（PKCE S256、単回使用の短命コード、scrypt ログインゲート、RFC 8707 の **audience バインド**、`vault.read`/`vault.write` の **scope ゲート**）を使います。

**Q. write はできますか？**
できますが、**既定は read-only** です。編集は `plan_document_update` →（承認）→ `apply_planned_update` の二段階で、ハッシュ不一致なら適用拒否（stale 保護）、新規作成は上書き禁止。web 経由の write は `MCP_HTTP_ALLOW_WRITE=1` **かつ** `vault.write` スコープの両方が揃ったときだけ有効になります。

**Q. データはどこに保存されますか？**
ノートは**あなたのマシンの `KNOWLEDGE_ROOT` 配下にのみ**存在し、コネクタはそこを参照するだけです。vault の実体・パス・本文はリポジトリにコミットされません。OAuth のトークンや登録クライアントは**プロセスメモリ上の一時状態**で、永続保存されません（再起動すると再認証が必要）。

### 社内・開発 FAQ

**Q. v0.1.0 でやらないことは？**
マルチユーザ／チーム共有（単一ユーザ前提）、OAuth 状態の永続化（再起動で再認証）、vault 以外のデータソース、全文の常時同期・インデックス配布。いずれも現状スコープ外です。

**Q. 次に追加する機能は？**
運用安定化のドキュメント（固定ドメイン tunnel ＋ プロセス常駐）、トークン永続化（再起動後も接続維持）、検索体験の改善、必要に応じたマルチユーザ対応が候補です。

**Q. 成功指標は？**
「vault を一切クラウドに上げずに、複数 AI から日常的に参照できている」状態の定着。導入までの時間（ローカル数分／web 10 分以内）、AI 横断での“貼り直し”消滅、そして**書き込み事故ゼロ**（二段階・stale 保護が機能）。

**Q. 失敗条件は？**
信頼を損なう事象 ―― vault 外へのアクセス、意図しない上書き/破壊、認証バイパス、private データの漏洩。これらは「起きてはならない一線」であり、セキュリティ挙動をテストで固定（path traversal / symlink escape / frontmatter allowlist / stale patch / overwrite collision）して回帰を防いでいます。設定の難しさで導入が数分に収まらないことも、普及上の失敗条件です。
