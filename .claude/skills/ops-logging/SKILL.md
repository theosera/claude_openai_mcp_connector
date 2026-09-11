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
  ⚠️⚠️ **【2026-09-11 訂正】否定 address は採らなかった。以下 4 段落は「なぜ採らなかったか」の記録である。**
  ⇒ ⭕ **出荷しているのは 2 つの形の組み合わせである** (2026-09-11 / owner 決定):
  **① bare / Bearer / auth-scheme の 3 本 = 値 class が 5 連ダッシュを跨げない形**
  (`([^[:space:]-]|-{1,4}[^[:space:]-])+`、auth-scheme は除外文字を足した同形)。
  **② 引用値は【1 引用符あたり 2 本】に分ける** — 前が **address 付き・dash 制限なし**、
  後が **address なし・dash 制限あり** (計 4 本)。
  ⇒ ⭐⭐ **②の 2 本は冗長ではなく、互いの穴をちょうど埋める**:
  ・**address 付き**は **marker 行【以外】**で完全に効く ⇒ ⭕ 引用値の内側の 5 連
  (`{"password": "abc{5ダッシュ}def"}`) と **PGP armor** を守る (どちらも dash 制限では
  マッチ全体が失敗して**丸ごと素通り**する)。
  ・**dash 制限**は **marker 行【でも】**効き、marker を食わない ⇒ ⭕ **値と marker が同じ行**
  (`{"password": "abc", "key": "{BEGIN marker}"}`) を守る (address は行全体をスキップするので
  ここが空く)。
  ⇒ ⭕ **逆検証は【半分ごと】に行う**: address 付き 2 本を落とすと 5 連と PGP が赤、
  dash 制限 2 本を落とすと同一行が赤 — **片方だけが赤くなる** (テストが pin)。
  ⚠️ **代償**: `-e` 規則が 2 本増え、1.39 MB / 22,550 行で **0.74s → 1.08s (+46%)**。
  ⛔ **hook にタイムアウトは無い**ので、巨大な tool 出力ではここが効く。
  ⚠️⚠️ **そして「2 本が互いの穴を埋める」関係は、次に触る人には見えない。**
  ⇒ ⛔ **片方だけ直すと穴が開く。** ⇒ ⭕ だから上の半分ごとの逆検証をテストに置いてある。
  ⚠️ 以下は当初 address を必須と書いた記録である (⛔ **消さない** — 次に同じ案が出たときのため):
  ⚠️ **この規則の否定 address (`/…PRIVATE KEY…/!`) は飾りではなく必須である。**
  sed は `-e` を**その時点の pattern space に順に**適用するので、ここでの置換は
  **下の PEM range の address が評価される前に marker を食える**。食うと range は開かず、
  prefix 付き (`cat -n` / `> ` / `grep -n`) の鍵本体は行頭固定 catch-all にかからないまま
  **そのまま出る** — **address を外すと多行ケース 54/54 で本体 6/6 行が漏れる** (実測)。
  ⛔ **「値の先頭の `-` を禁じる」では直らない** (marker を別の文字に接ぐ形で食われる: 実測 6/6 漏れ)。
  ⛔ **「PEM 規則の下へ移す」でも直らない** (keyword 規則が先に scheme 語を消すので不発: 実測)。
  ⚠️⚠️ **この address は【値を空白まで取る 3 本すべて】に要る** (2026-09-11 実測)。該当は
  **auth-scheme** / **bare keyword** / **Bearer 専用**の 3 本で、⛔ **どの 1 本を欠いても、
  その規則が開く形で本体 3/3 が漏れる** (単段の変異で 1 本ずつ赤を見た)。
  ⇒ ⛔ **上の「`Bearer` だけは専用規則が後続 token を取るので無事だった」は base の話で、
  値が marker そのものになる形では Bearer も食う** — これはテストが捕まえた (⛔ 手で作った
  7 検体はこの経路に届いていなかった)。⭕ **引用値 2 本は食わない**ので付けない (単独当てで確認)。
  ⚠️⚠️ **そして「PEM 規則を【上】へ移す」も採れない** (2026-09-11 / F-C)。上へ移すと範囲内の
  run 置換 `[A-Za-z0-9+/=]{12,}` が **`authorization` (13 文字) を食う** — アンカー長は
  token 5 / key 3 / secret 6 / password 8 / pat 3 / bearer 6 で、**12+ に届くのはこの 1 語だけ**。
  食われるとアンカーが消え、値が marker の 1 トークン右に**平文で残る**。
  ⇒ ⭐ **順序という 1 軸の上で、marker 食い (下だと漏れる) と F-C (上だと漏れる) が逆を向く**。
  ⇒ ⭐ だから **PEM を下に置く**のは正しい。⛔ **ただし「3 本に address を付ける」は誤りだった。**
  ⚠️⚠️ **address 版が作った新規の漏れ 2 件** (2026-09-11 / commit 前の走査が検出・独立に再現):
  ⛔ **① 値が marker と同じ行にあると平文で残る。** address は**行全体をスキップ**するが、
  PEM 規則が覆うのは **marker の span だけ** ⇒ END 行では range が開いていないので run 置換が走らず、
  BEGIN 行でも run class の 12 文字以上しか消えない ⇒ **値が 12 未満か `-` `_` `@` を含めば残る**。
  実測: `password: <値> {BEGIN}` / `password=<値> {END}` / `token=abc-def_ghi <BEGIN>` の 3 形で、
  **修正前と 46c61f7 ではマスクされていたものが漏れた**。
  ⇒ ⭐⭐ **守る単位が違うガード (行スキップ / span 置換) を組ませて、差 (行 − span) を誰も守らなかった形。**
  ⛔ **② 引用符付き marker が range を開かせない。** `key: "{BEGIN}"` (閉じ引用符あり) は
  引用値規則が食う ⇒ prefix 付き本体 3/3 漏れ。⚠️ **「引用値 2 本は marker を食えない」を
  裸の marker 1 つで確かめたのが誤り** — ⭐ **1 つの入力で試して「食えない」と結論した**形。
  ⇒ ⭕ **どちらも値 class の dash 制限で閉じる** (address を全部外せるので ① の原因が消える)。
  ⚠️⚠️ **【2026-09-11 再訂正 — この段落の代償記述は誤っていた】**
  「その先が残る」は **bare 規則にだけ正しい**。⛔ **引用値規則では【丸ごと不発】になる** —
  値 class の全選択肢が**非ダッシュで終わる**ので、値の**末尾がダッシュ 1 本**でも、`-\` でも、
  5 連でも**マッチ全体が失敗する**。⇒ ⛔ しかも JSON 形 (`"token": "…"`) では
  **bare 規則が落ち先にならない** (keyword と区切りの間の `"` を bare の `[=:[:space:]]+` が
  跨げない) ので、**値が 1 文字も消えない**。
  ⇒ ⛔⛔ **base64url の末尾が `-` になる確率は 1/64 ≈ 1.6%** — 下の 10^-9 は
  **bare 規則の内側の 5 連**の話で、⭐ **別の条件を同じ数字で語っていた**。
  ⚠️⚠️ **そして「5 連ダッシュを含むありふれた文字列は PEM marker」には反例がある**:
  **PGP の armor** (`{5ダッシュ}BEGIN PGP PRIVATE KEY BLOCK{5ダッシュ}`) は PEM 規則の
  `[A-Z ]*PRIVATE KEY` に**一致しない** (後ろに ` BLOCK` がある) ⇒ ⭐ **marker に見えるが
  PEM 規則には当たらない** ⇒ **引用値規則だけが守っていた**。⛔ 人が選ぶ password に
  5 連ダッシュがある形 (`{"password": "abc{5ダッシュ}def"}`) も同じで、⇒ どちらも
  「止まる対象が marker に一致する」の外側にある。
  ⚠️ 以下は当初の代償記述である (⛔ **消さない** — 数字の当てはめ先を間違えた記録として残す):
  ⚠️ **代償**: 値の中に 5 連ダッシュがあると**その先が残る**。⇒ ⭐ ただしこれは頻度の問題ではない:
  keyword 規則が守る形 (base64 / base64url / JWT / `ghp_` / `AKIA` / `xox` / UUID) は
  **どれも連続ダッシュを持たず**、base64url で 5 連続が出る確率は 1 位置あたり (1/64)^5 ≈ 10^-9。
  ⇒ ⭕ **5 連ダッシュを含むありふれた文字列は PEM の marker そのもの** ⇒ **止まる対象が marker に一致する**。
  ⚠️ 別席の実測 (tog `f182339` / md 38 ファイル 11,123 行): 素通りしたキーワード値 203 件のうち
  **5 連ダッシュを含むものは 0 件**。⛔ **ただしこの 0 が言えるのは「素通り分には無かった」まで** —
  コーパスは既にマスク済みなので、**マスク前の生の秘密が 5 連ダッシュを含むかは原理的に測れない**。
  ⚠️ **`sk-` / `xox[baprs]-` / `AIza` は値 class に `-` を持つので marker を食える** (HEAD~1 で
  本体 3/3 漏れを実測)。⇒ ⭕ これらを守っているのは **PEM 規則がその前に走ること**だけなので、
  **その順序をテストで pin した** (`gh[pousr]_` と `AKIA` は class に `-` が無いので位置を問わない)。
  ⛔ **「範囲内を行ごとマスクへ戻す」も採れない**: 終端が来ないと**無関係な 20 行が 20/20 消える**
  (実測)。⚠️ **fence 行を除外してもこれは直らない** — fence の偶奇 (i) と EOF までの破壊 (ii) は
  別の軸で、除外は (i) だけを直す。
  ⚠️⚠️ **上の「102 ファイル / 43,016 行で差分 0 行」は、この F-C の経路に届いていなかった** —
  そのコーパスは**開いた PEM range の内側に `authorization:` 行が続く配置**を構造的に含まない。
  ⇒ ⭐ **「検査が通った」は「検査が届いた」を含まない。**
  ⚠️⚠️ **address を付けない 4 本目がある**: URL 資格情報の規則
  (`s#(://[^/:@[:space:]]+):[^/@[:space:]]+@#`) も**空白で終端する値**を持つので、
  別席の機械的な列挙ではこの 3 本と同じ枠に入る。⛔ **付けていないのは、付けても直らないからである**:
  address は `/…(BEGIN|END) [A-Z ]*PRIVATE KEY…/!` なので、⭐ **marker の途中に `@` を植てた偽装
  (`-----BEGIN@RSA PRIVATE KEY-----`) には一致せず**、規則はその行で発火する。
  **実測 (2026-09-11)**: この偽装で prefix 付き本体 3/3 が漏れるが、**修正前 / tog の origin/main /
  修正後 / 189 に address を付けた版の 4 版すべてで同じ 3/3** — ⇒ ⭕ **既存の別欠陥**であって
  順序や address の管轄ではない (⭕ 同じ配置で marker を本物にすると 4 版すべて 0/3 = 対照は生きている)。
  ⇒ ⛔ **これは「marker を偽装すれば範囲が開かない」という族**で、閉じるには
  「marker らしい行をどう扱うか」の判断が要る (⏸ owner 手番・未着手)。
  ⭐⭐ **そして 189 が marker を壊せないことは、試したのではなく構造上そうである** (別席の論証):
  ① 範囲規則の address `{5 ダッシュ}BEGIN [A-Z ]*PRIVATE KEY{5 ダッシュ}` は
  **文字クラスの外にリテラル空白を持つ** ⇒ これに一致する文字列は**必ず空白を含む**。
  ② 189 の値 run (`[^/:@[:space:]]+` / `[^/@[:space:]]+`) は**どちらも `[:space:]` を除外**
  ⇒ **空白を跨げない**。⇒ ⭕ よって 189 の run は address が一致する文字列を**跨げない**。
  ⚠️⚠️ **保守条件 — この論証は「address がリテラル空白を含むこと」に乗っている。**
  ⇒ ⛔ **将来「空白を含まない marker」の規則を足したら、189 はそれを食えるようになる。**
  ⇒ ⭐ だから書いてあるのは「今は安全」ではなく「**何が変われば安全でなくなるか**」である。
  ⚠️ **検査の技法** (同じ席の副産物): masking 規則を検査するスクリプトは **egress guard に弾かれる** —
  検体を組み立てても**語そのものが残っていれば弾かれる**。⇒ ⭕ 通る形は
  「**検体を書かず、出荷中のパターンから導出する**」(範囲規則を特定 → address を取り出す →
  文字クラスを 1 語に固定して検体化)。⇒ ⭐ これは回避策ではなく**より忠実**である —
  自分が思う marker ではなく、**実際に出荷されている marker** を試すことになる。
  ⚠️ ⛔ **弾かれたバッチは「0 件を返した」のではなく【未実行】** — 同梱した `date` も巻き添えになる。
  ⚠️ ⭐ **列挙のフィルタ自身に陽性対照が要る**という形でもある: 当席は 189 を
  「`@` を要求するので食えない」と**推論で**除外していたが、⛔ 実際に食える配置が在った。
  ⇒ ⭕ 別席が「狭いフィルタなら何件か」を**同時に印字する**対照を置いたことで、**差 2 件が
  仮定だけで消えていた**ことが見えた (狭い 2 件 → 仮定を外すと 4 件)。
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
- ⭐⭐ **marker regex が覆う armor label の全数** (2026-09-11 実測 / owner 指示「PEM は重要、徹底的に」)。
  出荷している形は `{5ダッシュ}(BEGIN|END) ([A-Z0-9 ]*PRIVATE KEY|PGP MESSAGE){5ダッシュ}` で、
  **mask() 内の 6 出現すべてが同一** (range の start/end・BEGIN/END 置換・address 付き引用値 2 本)。
  ⇒ ⭕ **範囲が開く (= prefix 付き本体が守られる)**: `RSA PRIVATE KEY` / `PRIVATE KEY` /
  `ENCRYPTED PRIVATE KEY` / `EC PRIVATE KEY` / `DSA PRIVATE KEY` / `OPENSSH PRIVATE KEY` /
  **`SSH2 ENCRYPTED PRIVATE KEY`** (★ 数字を許して直った) / **`PGP MESSAGE`** (★ `PRIVATE KEY` を
  含まない枝を足して直った)。
  ⇒ ⛔ **範囲が開かない (公開物なので意図的)**: `CERTIFICATE` / `RSA PUBLIC KEY` /
  `PGP PUBLIC KEY BLOCK` / `PGP SIGNATURE` / `X509 CRL`。
  ⚠️⚠️ **⛔ `PGP PRIVATE KEY BLOCK` の【prefix 付き複数行】は開かない — 既存の欠陥で、層を分けて残した**。
  ⇒ ⭐ 機序: **bare keyword 規則が `KEY BLOCK` を「keyword + 区切り + 値」と読んで `BLOCK` を
  `***MASKED***` にする** ⇒ marker が壊れ、range の start address が評価される前に範囲が開かなくなる。
  ⇒ ⛔ **46c61f7 でも同じく漏れていた** (実測) ので本変更の退行ではない。
  ⚠️⚠️ **そして marker regex に `( BLOCK)?` を足して直そうとしてはいけない** (実測で却下):
  address も同時に広がるので、⇒ ⛔ **address 付き引用値規則が PGP BLOCK 行をスキップし、
  JSON 1 行形 (`{"key": "…BEGIN PGP PRIVATE KEY BLOCK…"}`) と引用値形が【新たに】漏れる**
  (`( BLOCK)?` 無しでは両方 ⭕、足すと両方 ⛔ / 実測)。
  ⇒ ⭐⭐ **marker を広げると address も広がり、引用値の address 付き半分がその行を手放す** —
  ⭐ **広げるほど「引用値の中の armor」が守られなくなる**という逆向きの関係がある。
  ⇒ ⭕ **層 1 では `PRIVATE KEY` の【前置修飾】だけを広げ (数字を許す)、後置は広げない。**
  ⇒ ⛔⛔ **しかも 1 行目は部分マスクされる** (`{5ダッシュ}BEGIN PGP PRIVATE KEY ***MASKED***{5ダッシュ}`) —
  ⭐ **漏れているのに redaction に見える**、最悪の形。⇒ ⭕ **テストで pin してある** (修正すれば赤くなる)。
  ⚠️⚠️ **⛔ 「range の start を緩める」で直そうとしてはいけない** (実測で却下)。
  `{5ダッシュ}BEGIN [^-]*{5ダッシュ}` にすると `PGP PRIVATE KEY BLOCK` は守れるが、
  ⇒ ⛔ **攻撃者が `{5ダッシュ}BEGIN X{5ダッシュ}` を 1 行植てるだけで、以降の commit sha 3 本と
  絶対パス 2 本が 5/5 すべて消える** (散文の `{5ダッシュ}BEGIN of file{5ダッシュ}` や
  `CERTIFICATE` でも同じ)。⇒ ⭐ 置換 token は `***MASKED***` なので、**破壊が通常のマスク処理に見える**。
  ⚠️ **「bare 規則に marker address を付ける」も却下** — ⛔ 値が marker と同じ行にある形で
  平文が残る (Finding 1 の再演。address は行全体をスキップするが PEM 規則は marker の span しか覆わない)。
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
