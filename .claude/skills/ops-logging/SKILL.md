---
name: ops-logging
description: Claude Code UI で実行した git / shell / GitHub(MCP) 操作を「コマンド＋意図」だけ (secret 全マスク) 学習ログとして専用 private リポ (terminal-ops-logs) に push する仕組みの正典。PostToolUse hook で追記 → Stop hook で 1 回 push。**コマンド学習ログ機能を新リポへ導入する / hook 設定 (settings.json) を書く・直す / マスキング規則やログ出力先を変える / capture-command.sh・push-log.sh を触る前に必ずこの Skill をロードしてから**着手せよ。実際の自動実行は hook が担い、本 Skill は設定の母艦 (手順・規則・スニペット)。
# allowed-tools: 導入時に settings.json とスクリプトを書く必要があるため Write/Edit/Bash を許可。
allowed-tools: Read, Write, Edit, Bash
---

# ops-logging

Claude Code UI 上で私が打つ **git / shell / GitHub(MCP) 操作**を、学習用の
**コマンド履歴**として Obsidian vault とは分離した専用 private リポ
**`terminal-ops-logs`** に貯める仕組み。CLAUDE.md の発火表から発火条件付きで
分離した「設定の正典」。**自動実行は hook が担う** (Skill は自動実行できない —
本 Skill は手順・規則・スニペットの母艦)。

## 設計の要点 (なぜこの形か)

- **記録は「コマンド＋意図」だけ。出力 (stdout) は記録しない。** `env` ダンプや
  token がログに乗る事故を構造的に防ぐ (3 リポ共通の「secret を絶対 commit しない」
  ハードルールの具体化)。
- **「意図」は無料で手に入る:** Bash ツールの `description` フィールド (私が毎回書く
  「何をするか」) を hook がそのまま意図として拾う。追加入力は不要。
- **push は Stop で 1 回だけ。** PostToolUse は追記のみ (push しない=軽い)、ターン
  終了時に Stop hook がまとめて commit & push。コミットが細切れにならない。
- **vault と分離。** 学習ログは git リポで完結させ、重い Obsidian vault に混ぜない。
  (必要なら `terminal-ops-logs` を Obsidian で別 vault として開けば Dataview 可。)

## 仕組み (1 セッションの流れ)

```
私が作業中…
 ├─ git switch -c ...        ┐ PostToolUse hook (matcher: Bash, mcp__github__*)
 ├─ git add classifier.ts   │→ capture-command.sh が
 ├─ git commit -m ...        │   <target_repo>/<date>.md に「コマンド＋意図」を 1 行追記
 └─ mcp__github__create_pr   ┘   (Bash=token/key/bearer をマスク / MCP=安全な
                                  メタデータ allowlist のみ。body/title/本文は捨てる)
私の応答が終わる
 └─ Stop hook → push-log.sh が変更を commit して terminal-ops-logs へ push
                (差分が無ければ no-op。push 失敗はターンをブロックしない)
```

## ログリポの構成 (`terminal-ops-logs`)

```
terminal-ops-logs/
├── README.md                         # コマンド早見表 (学習の母艦)
├── obsidian-ai-pipeline/<date>.md
├── claude_openai_mcp_connector/<date>.md
├── pipeline-youtube-SDK/<date>.md
└── <origin-repo>/<date>.md           # cwd の git リポ名でフォルダを自動作成
```

> フォルダは**元リポ名ごとに自動作成**される (cwd の git repository root 名。
> git 管理外なら cwd の basename)。既知リポの列挙は不要 — 未知リポは初回コマンドで
> 自分のフォルダを得る。「その他」用の `misc` バケットは廃止済み。

各 `<date>.md` 先頭の frontmatter: `date` / `target_repo` / `branch` / `tags`。
本文は `| time | branch | command | intent |` の Markdown テーブル。
→ Obsidian で開けば Dataview で「リポ別・ブランチ別」に一覧可。

## 新リポへの導入手順

1. **ログリポを clone** しておき、パスを環境変数で指す:
   `export OPS_LOG_REPO=/path/to/terminal-ops-logs` (既定 `$HOME/terminal-ops-logs`)。
   このリポが clone されていなければ hook は **何もしない (no-op)** ので安全。
2. **hook スクリプトを配置** (本 Skill 同梱の 2 本をそのまま使う):
   - `.claude/skills/ops-logging/capture-command.sh` (PostToolUse)
   - `.claude/skills/ops-logging/push-log.sh` (Stop)
3. **対象リポの `.claude/settings.json` に hook を登録** (下記スニペット)。
   配置方針は「対象リポ側」(そのリポで作業した時だけ発火)。
4. `jq` が必要 (hook が JSON payload を解析するため)。

### settings.json スニペット (対象リポ側に追記)

```jsonc
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash|mcp__github__.*",
        "hooks": [
          { "type": "command",
            "command": "bash .claude/skills/ops-logging/capture-command.sh" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command",
            "command": "bash .claude/skills/ops-logging/push-log.sh" }
        ]
      }
    ]
  }
}
```

> `permissions.deny[]` (既存の secret 読取ブロック) とは別セクション。既存
> `settings.json` の `permissions` は残したまま `hooks` を**追加**する。

## マスキング規則 (capture-command.sh 内)

コマンド文字列に含まれうる以下を `***MASKED***` に置換してから記録する
(出力は元々記録しないが、コマンド自体に token が混ざる場合の保険):

- GitHub token: `gh[pousr]_…` / `github_pat_…`
- URL 埋め込み credential: `://user:pass@`
- `Bearer <token>` は**単位でマスク** (`Authorization: Bearer xxx` の token を残さない)
- `token=` / `key=` / `secret=` / `password=` / `authorization …`
- **同じ keyword の引用値** (`"access_token": "…"` / `{'api_key':'…'}`)。JSON には空白が
  無いので上の規則は発火すらしない (keyword の次が引用符)。引用符ごとに 1 本ずつ、計 2 本。
  値は escape を解する (`"p@ss\"word"` を escape された引用符で切らない)。
  **閉じ引用符を必須にしている** — 無いと行末まで走り、`grep -n "token: " src/*.ts` の
  ような「閉じ引用符が開き引用符に見える」行で残り全部が消える (F12 と同型の暴走)。
  閉じ引用符が無い値は上の keyword 規則が空白までマスクするので、被覆は落ちない。
- ⚠️ **上の keyword 規則は「引用値規則の落ち先」なので byte 単位で変えない。**
  変えると「以前はマスクされていた入力が平文で残る」経路ができる。
- **auth scheme 付きヘッダ** (`Authorization: <scheme> <credential>`) は **2 トークン**なので、
  上の keyword 規則は**空白で値を切って scheme 語だけを消し、credential を marker の
  右隣に平文で残す** (= 成功した redaction に見える)。`Bearer` だけは専用規則が
  後続 token を取るので無事だった。**keyword + scheme + credential を 1 本で消す規則**を
  keyword 規則の**直上**に置く (直下では scheme 語が既に `***MASKED***` になっていて発火できない)。
  scheme は **allowlist** (`Basic` / `Digest` / `Token` / `ApiKey` / `OAuth` / `SSWS`) — 汎用の
  scheme 語にすると「keyword の次の次の語を消す」規則になり、**引用符無しの frontmatter**
  (`project:` / `repos: [...]` / `tags: [...]`) の隣の値まで巻き込む。
  ⚠️ **この規則の否定 address (`/…PRIVATE KEY…/!`) は飾りではなく必須である。**
  sed は `-e` を**その時点の pattern space に順に**適用するので、ここでの置換は
  **下の PEM range の address が評価される前に marker を食える**。食うと range は開かず、
  prefix 付き (`cat -n` / `> ` / `grep -n`) の鍵本体は行頭固定 catch-all にかからないまま
  **そのまま出る** — **address を外すと多行ケース 54/54 で本体 6/6 行が漏れる** (実測)。
  ⛔ **「値の先頭の `-` を禁じる」では直らない** (marker を別の文字に接ぐ形で食われる: 実測 6/6 漏れ)。
  ⛔ **「PEM 規則の下へ移す」でも直らない** (keyword 規則が先に scheme 語を消すので不発: 実測)。
  ⚠️ **残渣 1**: `Digest` や OAuth 1.0a のような**パラメータ列**の scheme は値が引用符で終わるので
  `response=` が残る。**base と同じ漏れ**で悪化ではないが、**閉じてもいない** (テストで pin 済み)。
  ⚠️ **残渣 2**: allowlist 外の scheme (`Negotiate` / `NTLM` / `AWS4-HMAC-SHA256`) は base のまま。
  ⚠️ **代償**: keyword の直後に scheme 語が来る散文は**次の 1 語**も消える。
  **実測**: base commit 時点の追跡テキスト **102 ファイル / 43,016 行**を
  **ファイル全体 1 ストリーム**で新旧 `mask()` に通して**差分 0 行**
  (`MASKED` を含む行数 916 → 916、マスクが減った行 0)。本変更が足した文面まで含めても
  差分は **5 行**で、すべて本規則自身のコメント・テスト本文であり**マスクが増える側**である。
  ⚠️ **測り方を変えた**: 従来の **1 行ずつ**の corpus では、**range address を持つ規則の回帰を
  原理的に観測できない**。上の実測は**ファイル全体を 1 ストリーム**で通し、加えて
  多行の PEM corpus (scheme x prefix x marker 位置) で base と比べている。
- ⚠️ **引用値を丸ごとマスクする代償**: 秘密でない `"key": "…"` や keyword に続く引用句も消える。
  **マスク過剰側に倒す判断**であって「影響なし」ではない。
  **実測** — 追跡下の `.md/.ts/.sh/.json/.yml` **99 ファイル / 36,330 行**を新旧両方の `mask()` に
  通して出力を比較したところ、**出力が変わるのは 3 行**、**`MASKED` を含む行数は 686 → 686 で不変**
  (= **新たにマスクされる行は 0**、3 行はいずれも既にマスク済みの行の消し残りが縮む方向)。
  ⚠️ **この母集団はリポの原文であって hook の実入力ではない** — 実入力は Bash コマンド文字列と
  セッション本文 (JSON の tool 出力を含む) なので、**利益もコストも過小に出る**。「3 行」は
  上限の証明ではない。
- AWS `AKIA…` / OpenAI 系 `sk-…` (ハイフン付き `sk-proj-…` / `sk-ant-…` も対象)
- Google API key `AIza…` / Slack `xox[baprs]-…`
- **PEM 秘密鍵**: BEGIN / END の marker 行を置換し、その範囲 (BEGIN 〜 END、または
  **次の column 0 の `~~~` 行**まで) の中で **base64 文字の 12 文字以上の連なりを置換**する。
  本 hook の従来規則は **BEGIN〜END を行ごと空にする**もので、今回それを
  行内置換へ変えた。⚠️ **失うもの**: 12 文字未満の連なり (本体最終行が
  4 / 8 文字のとき)、`Proc-Type:` 等の非 base64 ヘッダ、本文に植えられた
  column 0 の `~~~` より後ろ。⚠️ **得るもの**: 従来は END が無い marker が
  1 つあるだけで**コマンドの残り全行が無音で消えていた** (実測 501 行中
  501 行が消え、鍵素材は 1 つも含まれていなかった) — 行内置換ではそれが
  起きない。
  ⚠️ **行を丸ごと空にはしない。** session-archive 側がマスクするのは組み立て済みの
  ノートで、そこには renderer の `~~~~~~` fence が既に入っている (ops-logging 側は
  コマンド文字列をマスクし、その後 1 行へ畳むので自前の fence は無い)。行ごと消す規則は
  **閉じ fence も一緒に消す** ので、消えた fence 行が奇数個なら以降の偶奇が反転し、
  次の tool 出力が **地の文として** 読まれる (untrusted な出力が「操作者が言ったこと」に
  昇格する)。行内置換なら fence 行 (`~` は base64 文字ではない) に触れようがないので、
  **行数の上限は要らない** — 上限こそが、END の代わりに fence 行を消して穴を戻す。
  ⚠️ **column 0 の `~~~` 行での終端が閉じ込めるのは「fence されたブロック」だけ**である。renderer が
  fence を出すのは tool 結果 / thinking / tool 入力で、**assistant・user の文章 turn は
  fence されない** — そこに植えられた開始 marker は、**次のブロックの開き fence まで
  (fence されたブロックが後に無ければノート末尾まで)** 走り、途中の 12 文字以上の連なりを
  置換する。⚠️ **この「連なり」は base64 に限らない** — 文字クラスは英数字 + `+ / = \` で、
  **`/` が入っているため絶対パス 1 本が丸ごと 1 連なりになり** (`/home/runner/work/repo/checkout`)、
  ありふれた 12 文字の英単語も hash もまとめて消える。⛔ 置き換わるのは `***MASKED***` —
  **本物の redaction が出すのと同じ token** なので、**壊された内容は「通常のマスク処理」に
  見え、誰も見に行かない**。**実測**: 合成 `git log` 30 行 + 絶対パス 3 本のノートで、marker が
  無ければ 0 個マスク・SHA 30/30・パス 3/3 が残るのに、**31 byte の marker を 1 つ植えると
  91 個マスクされ 0/30・0/3 になる**。⚠️ **つまり失うのは可読性ではなく、攻撃者が狙って
  選べる破壊である。** それでもこの範囲を採るのは **prefix 付きの鍵本体をマスクできるのが
  この範囲だけ**だからで、**意図した取引**として引き受けている。**構造は失わない**
  (置換は行を消せない)。この到達範囲はテストで pin してある。
  ⚠️ **`~~~` 行は renderer の専有ではない。** 本文は fence の中に**そのまま**出るので、
  tool 結果自身の本文に column 0 の `~~~` があれば範囲はそこで**早期に閉じ**、以降の本体行は
  行頭固定の catch-all だけが頼りになる (prefix 付きなら残る = 攻撃者が届く漏れ)。
  ⛔ **そもそも終端は fence である必要すらない。** address は `^~{3,}` で右端が固定されて
  いないので、**renderer が「fence は閉じられない」と判定して意図的に幅を広げない
  `~~~ label` でも、この範囲は閉じる** (実測: prefix 付き本体 6 行が 6 行とも漏れる)。
  **「fence を閉じられない」は「この範囲を閉じられない」の理由にならない。**
  ⛔ **範囲が開き直るのは「tilde より後ろに BEGIN marker がある」場合だけ**であり、
  鍵が自分の BEGIN 行を持っていること自体では守られない。鍵自身の BEGIN 行と本体の
  間に tilde を置けば本体が始まる前に範囲が閉じ、本体行は全部漏れる (実測: `cat -n`
  prefix 付きで 6 行中 6 行)。**攻撃者が選ぶのはこの形なので、この節を漏れの上限として
  読まない。**
  ⚠️ **空行で終端してはいけない** — RFC 1421 の暗号化鍵は `Proc-Type:` /
  `DEK-Info:` ヘッダの後に**空行**を置き、その次から本体が始まる。空行で切ると
  **鍵本体の直前で止まる**。
- **base64 だけの行** (32 文字以上) は marker 無しで貼られた本体の catch-all として
  行ごとマスクする (今回の変更で除外は 1 つも増えていない)。
  この catch-all は本 hook では**新規追加**である (session-archive 側には
  既にあった)。
  ⚠️ **行頭固定の規則だけでは足りない**: `cat -n` の「行番号 + TAB」や `> ` 引用、
  `grep -n` の `file:12:` が付いた本体行はどれも行頭固定にかからない
  (**diff の `+` は例外** — `+` は base64 文字なので、prefix 付きでも元からマスクされる)。

新しい token 形式が増えたらこの規則とスクリプトの `mask()` を更新する
(マスク漏れはこの Skill の回帰なので、追加時は必ずここに 1 行追記)。

> **GitHub MCP 呼び出し (`mcp__github__*`) は別扱い**: `tool_input` 全体は記録せず、
> 構造メタデータの allowlist (`owner` / `repo` / `pullNumber` / `branch` / `path` /
> `method` 等) **のみ**を残す。PR/issue body・コメント・file contents 等の自由文は
> 正規表現マスクで守り切れないため、そもそもログに載せない (「コマンド＋意図のみ」保証)。

## 環境による発火可否 (重要)

| 環境 | 発火 | 条件 |
|---|---|---|
| ローカル Claude Code CLI | ◯ | `OPS_LOG_REPO` が clone 済みなら常時 |
| Claude Code on the web (コンテナ) | △ | **`terminal-ops-logs` をそのセッションのスコープに含め、コンテナ内に clone されている時のみ** push 可。スコープ外だと push 段階で拒否される |

> コンテナは ephemeral。web セッションでログを残すには `terminal-ops-logs` を
> セッションスコープに追加して起動する必要がある (3 リポ既定 + 要望時追加の方針に従う)。

## ハードルール (退行させない)

- **出力 (stdout/stderr) はログに含めない。** コマンドと意図のみ。
- **`push-log.sh` の add は生成された日付ログのみ** (`find … -name
  'YYYY-MM-DD.md'`)。`README.md` 等の手書き markdown や `git add -A` を巻き込まない
  (中途半端な手書きノートを勝手に publish しない / 3 リポ共通文化)。
- **hook はツール実行をブロックしない** (`exit 0` で抜ける) — ログ機構の失敗が
  本来の作業を止めてはいけない。
- マスキング規則を緩めない。token 形式追加時は規則＋スクリプト＋テストを更新。

## See also

- `capture-command.sh` / `push-log.sh` — 同梱 hook スクリプト (実体)
- `terminal-ops-logs/README.md` — コマンド早見表 (git/gh/shell の学習索引)
- CLAUDE.md スキル発火表 — 本 Skill の発火条件 (導入・設定変更時にロード)
- `docs/skills-design.md` — Skills 構成規約 (フラット固定 / 命名 / カテゴリ索引)
