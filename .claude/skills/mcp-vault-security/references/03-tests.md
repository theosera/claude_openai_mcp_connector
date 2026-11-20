## テストで固定する (規約でなく実行可能な保証)

セキュリティ挙動は `pnpm test` (vitest) で pin する。

> **★ 逆検証を先に済ませる。** 下の一覧を満たすテストを書いたら、**そのガードを外して赤くなる
> ことを実測してから** merge する。**触ったガードごとに 1 回ずつ** — 1 PR で複数の INV に
> またがったなら、その数だけ実施する (1 つ測って全体の代表としない)。
> 緑は「壊れていない」であって「守っている」ではなく、
> **その分岐を踏む入力を作らない限り、そのテストは何も証明していない**。
> 赤の理由が**そのガードの不在**であることまで確認する (別の理由で落ちても意味がない)。
> 以下は変更当時の実測。Host / Origin の現在の検査箇所は `src/httpServer.ts` の `rejectRebinding`。当時は旧 transport の設定変更で境界テスト 2 本だけが失敗した。
> `legacy:'reject'` で 2025 leg が `-32022` / `cacheScope:'public'`・`ttlMs:60000` が**個別に**
> 落ち、かつ**捕捉そのもの**を assert して vacuous な緑を塞ぐ / `MCP_HTTP_ALLOW_WRITE` を
> 宣言だけ off にした当時の実測は 5 件。現在の `classifySurface` は一般文書の plan/apply 4 種と legacy create 1 種を分け、実際に公開された一覧と許可の組み合わせから指摘を決める。
> **チェックが FAIL したときも同じことを問う** — 検査した結果か、検査に**到達しなかった**結果か。
> (#91: `check-http.mjs` は 2b 以降ずっと FAIL していたが、比較の手前で throw していたので
> surface 検査は一度も走っていなかった。)

> **★★ 逆検証そのものが空振りする。「mutation を入れた」と「mutation が届いた」を別々に確認する。**
> **実測: #122 で 2 件・#125 で 4 件、入れた mutation がそもそも当該分岐に到達しなかった** —
> **整形でパターンが一致しなくなった** / **狙いと違う最初の一致に当たった** /
> **定数が両辺に現れて相殺した** / **呼び出しが読まなくなったフィールドを読んだ**。
> **6 件とも「ガードが効いていて緑」と見分けがつかない。** 逆検証を実施した記録だけが残り、
> 実施できていない状態になる。
> ⚠️ **`GD-VACUOUS-CHECK` の系だが、対象が 1 段ずれている** — あちらは**テストがガードに
> 到達したか**、こちらは **mutation がガードに到達したか**。
> **検査を検査する手続き自身が vacuous になりうる**、ということ。
> ★ **唯一効いた形**: mutation を入れた版で**狙った assert が実際に赤くなったこと**を確かめ、
> **その確認をテスト側に書き残す** (#122 / #125 はどちらもそうした — 次に逆検証する人は
> その形を真似ればよい)。
> ★ **届いた mutation は、ガードの不在以外のものも露出させる** — #125 では届いた 2 件が
> **本物の穴**を出した (`recent_docs` の中身が何も pin されていなかった /
> include の検査が「無視された場合」と区別できていなかった)。
> **赤が出たら「pin できていた」で終えず、「何が pin できていなかったか」を読む。**

> **★ 逆検証が vacuous になりやすい 3 つの形。設計の時点で外す** (テストを書いてからでは遅い)。
> **① 既定を変えない変更は、既定経路のテストでは何も証明しない** — ガードを外しても全部緑になる。
> **狭めた設定を明示的に踏む経路**でテストし、**捕捉そのもの**を assert する
> (`MCP_AUTH_TOKEN_SCOPES` を狭めて write tool が `tools/list` から消える形が該当)。
> **② 要件が「載せないこと」なら、主 assert は negative でなければならない** —
> 「出ること」を assert するテストは、**載せてはいけないものが混入しても緑のまま通る**。
> INV-9 で監査 frontmatter を「書けること」ではなく**「名乗れないこと」**で pin したのと
> 同じ形 (現在は `assertAuditWritableFrontmatter`。`assertNoServerOwnedFrontmatter` は
> INV-8 の Skill reference 側に残っている — **関数名で grep する読み手のために、
> どちらがどちらか明示する**)。
> **③ 起動行を検査に使わない。起動行は「主張」であって「面」ではない** — 実測: #113 の逆検証で
> Skill gate を戻したとき赤くなったのは**ワイヤ上のテスト 1 本だけ**で、起動行を見るテストは
> 緑のままだった。起動行の assert は**補助まで**。

> **★ 1 つのファイルについて複数の属性を assert するときは、単一 handle から取る。**
> `fs.stat(path)` の後に `fs.readFile(path)` と書くと、**assert 同士が別バージョンのファイルを
> 指しうる** — 「inode が変わった」と「中身が新しい」が同じファイルの話である保証が無い。
> 本番コード (`readDocument` / `applyPlannedUpdate` / `replaceFileAtomically`) が handle 経由で
> 揃えているのと同じ理由が、テストにもそのまま当てはまる。
> **実測: CodeQL が #106 / #107 / #108 で同じ形を 3 回連続で検出した** (いずれも新規テスト、high)。
> **3 回とも「このルールを読んだ上で」踏んでいる** — 規約として覚えるのでは足りない。
> **テストで同じパスに 2 回触れそうになったら、その時点で handle にする**のが唯一効いた形。
> ⚠️ **これは `GD-VACUOUS-CHECK` とは別の失敗モード。** あちらは**検査に到達したか**、
> こちらは**検査対象が同一か**。テストは正しく到達しており、見ている対象がズレうるだけ。

次の path traversal 行でいう malformed escape は、同じパスに脱出も含まれる場合を指す。`tests/pathSafety.test.ts` は孤立したパーセント記号を含む通常のファイル名が通ることも確認する。

最低限カバー:

- path traversal (`../`, encoded `%2e%2e`, malformed escape `%ZZ`, 絶対, `~`, NUL/制御文字, 超過長) → reject
- symlink escape (root 外を指す symlink) → reject / symlink cycle (`loop → root`) → 無限再帰せず完了
- frontmatter allowlist (未知キー patch) → reject / 値型違反 (非 string / 非 string[]) → reject
- **frontmatter block 長 (INV-2 / 二次 CPU)**: 上限超過は reject / **終端が無く、ブロックとして数えた全体が上限を超える場合**も parse 前に拒否
  (ファイル全体がブロック扱いになる最悪ケース) / **frontmatter が無い巨大ノートは通る** (誤検知の逆)。
  ★ **時間も assert する** — ガードを外すと終端なしのテストが **177 秒**かかる (1 秒の assertion に対し 177 倍)。
  「throw する」だけでは、その throw が parse の前か後かを区別できない
- **id squatting (INV-2 読む側)**: 他文書の path / uuid を `id` に宣言したノートを置くと
  `fetch` が **両サイトで** fail closed (`KnowledgeStore` = 単一ルート / `MultiRootStore` =
  squatter を primary、被害者を read-only root に置き **composite でしか見えない衝突**にする) /
  `plan_document_update` が偽装先に staged されない / 衝突が無ければ uuid・path 参照は従来どおり
- two-step: plan→apply 成功 / 外部編集後 apply → stale reject / **apply は rename で置換**
  (`ino` が変わる・権限保持・`.tmp` を残さない) / **同一基点の 2 本同時 apply は 1 本成功 + 1 本 stale**
  (直列化が無いと**両方成功**する = lost update)
- **scan の絞り込み (`path_prefix` → walk)**: prefix 付き検索が**絞らない検索の結果に同じ prefix を
  後からかけたものと同じ結果**を返し (prefix の外にも当たる note があれば、絞らない検索そのものとは
  一致しない)、かつ
  **実際に walk が縮んでいる**。⚠️ **2 つの半分は別の syscall で測る** — file を飛ばしたら `open` が減り、
  subtree ごと飛ばしたら `readdir` が減る。**実測: `open` だけを数えていたら、`subtreeMayMatch` を
  `return true` に潰しても全テストが緑だった** (per-file 判定だけで `open` は抑止されるため)。
  ⚠️ **prune は escape の検出範囲も狭める** — 従来はどの検索でも walk が全域を回るので、vault の
  どこかに symlink escape があれば必ず throw した。prefix 付き検索は subtree を飛ばすので、
  **同じ設定ミスが prefix 無し検索でしか鳴らなくなる** (アクセスは許していない — 飛ばした側は
  読まれもしない)。
  `path_prefix` は**ディレクトリ名でなく素の文字列 prefix**のまま (`projects/chatgpt/res` が
  `research/` に届く = prune の「prefix の方が深い」節) / `fetch`・`trace_sources`・`list_projects` は
  **絞らない** (INV-2 の id 一意性と backlink 完全性は部分集合の上では「少ない」でなく「誤り」)
- **parse cache の鮮度**: 同サイズ・**mtime を固定値に戻した**外部編集を read が拾う。
  ★ **mtime は「観測した値を戻す」のでは駄目** — `utimes` が ns を切り捨てるので mtimeNs が
  変わり、**ガードを外しても緑になる** (実測でこれを踏んだ)。秒単位の固定値を前後で入れる
- **`check:http` の認証情報**（`tests/checkHttp.test.ts`）。対象が 1 つなら設定済みの環境値を優先し、不在ならファイルを使う。引数を省いたときも実装は 1 対象として扱う。複数なら各ファイルから選ぶ。試験は選択元の表示・不一致の警告・未設定による失敗を確認する。`resolveBearer` が選んだ値に残る制御文字を `sendable` が送信前に拒む。実装が拒む範囲は C0 と DEL。試験はその代表について環境とファイルの各経路で失敗終了、受信 0 件、出力に値がないことを確認する。`leaked` 自身の陽性対照もある。
- 一段階 create の gate: 既定で `create_document` が**登録されない** (両 era・両 transport) /
  `MCP_ALLOW_LEGACY_CREATE_DOCUMENT=1` で戻る (「消した」のではなく「gate した」ことの確認)
- exact-path create: plan は対象側無変更 / `はい` + 自由記述の確認payload / confirmed path不一致・
  staged content改ざん・非primary root・traversal・symlink parentをreject / MCP E2Eでapply→read-back
- overwrite: 同一 create 2 回目・plan後collision → already exists
- Skill create: plan では target 無変更 / apply で bundle 全体作成 / overwrite・traversal・
  symlink escape・不正 frontmatter・許可以外の file を reject / Skill-only HTTP surface を確認
- HTTP transport: token 欠落/不正 → 401 / 正トークン → handshake 成功 / read-only 時に
  write tool が tool 一覧に出ない / write 許可時に出る / chatgpt `search`・`fetch` の出力形状
- per-request 解決 (2b): **1 クライアント・1 接続で bearer を差し替える**と tool 面が追従する
  (「2 クライアント × 2 token で面が違う」は session 時代でも通るので**証拠にならない**) /
  `vault.read` 無しの token は 403 + `insufficient_scope` challenge / consent ページが granted scope を表示
- dual-era: 2025 era (sdk v1 client) と 2026-07-28 era (`@modelcontextprotocol/client` v2、
  `versionNegotiation: { mode: { pin: "2026-07-28" } }`) が**同一エンドポイントで両方 negotiate** し
  **同じ tool 面**を見る / **どちらの era も `mcp-session-id` を発行しない** / modern でも read-only 既定と
  401 と Host 403 が効く (実際の modern request を捕捉して verbatim replay する) /
  modern era でも **scope→tool 面が request ごと**に効く (`vault.read` と `vault.read vault.write`
  の 2 token を同一エンドポイントに連続投入し、read 側が後からでも write tool を見ないことを固定)
- dual-era **stdio** (2c): **spawn した実 entrypoint** に v1 client (2025) と v2 client
  (2026-07-28 pin) を繋ぎ、**同一の既定 tool 面**（二段階 document write あり）と `SERVER_INSTRUCTIONS`
  がワイヤ上で**両 era に届く**ことを固定 / modern era で実 tool call が通る (discovery だけで
  緑にしない)。Skill・監査を明示的に許可した両 era の一致と、legacy create の許可は別の試験で見る。赤緑実測: `legacy:'reject'` で 2025 leg が `-32022`、旧配線に戻すと両 leg が落ちる
- runbook 契約: sessionless なので `GET`/`DELETE /mcp` は `405`、`tools/list` は**単独 POST**で通る
  (operations.md に載せる curl をテストで固定 — 手順書がサーバから乖離しないため)
- Host allowlist: `hostnameOf` の port 剥がし・IPv6 bracket / port 省略表記でも genuine が通り
  hostile は 403 / Origin は scheme 違いを拒否 (完全一致)
- OAuth 2.1: PKCE 一致/不一致, redirect policy (https/loopback のみ), code 単回・失効,
  refresh rotation, パスワード誤り → code 不発行, full flow (discovery→register→authorize→
  token→OAuth access token で `/mcp` 接続), 未認証 `/mcp` → 401 + `WWW-Authenticate`
- **サーバ state の置き場所 (根 E の隣 / B-3)**: `MCP_OAUTH_STATE_FILE` が vault 内 → boot で reject し
  **どのルートかを名指し** / **vault へ向く symlink 経由**も reject / **宛先が未作成の dangling symlink** も reject
  (`realpath` 版が見逃す形) / **`..state` のようにドット 2 つで始まる名前**のディレクトリも reject
  (`startsWith("..")` が誤って「外」と判定する形) / 二次 read-only root でも reject / vault 外は従来どおり通る /
  root 未設定で state file を指定 → **fail closed** / **明示指定と既定の `MCP_PATCH_STATE_DIR` の両方** /
  symlink cycle は**有界なエラー**で終わる (boot が返らないのを防ぐ)。
  ★ 逆検証は**呼び出しサイトごと・ガードごとに 1 回ずつ**。実測: OAuth 側の呼び出しを外すと 4 本 /
  patch-state 側を外すと 1 本 (**集合が交わらない**) / `(dev,ino)` 比較を壊すと 7 本 /
  文字列 fallback を `startsWith("..")` に戻すと 1 本 / hop 上限を 0 にすると symlink 2 本。
  ⚠️ **大文字小文字の同一性そのものは case-sensitive な FS 上のテストでは踏めない** — Linux CI では
  `/x` と `/X` が別ディレクトリなので、その形のテストは vacuous になる。`(dev,ino)` 機構が生きていることは
  上の逆検証に加え、`tests/config.test.ts` の `rejects a state file under a case variant` が実 FS を判定し、同じディレクトリを指す環境で検査する。別のディレクトリを指す環境では skip する
- **エラー面のパス漏洩 (根 E / F9)**: 未知 `patch_id` で apply → patch-state dir も `$HOME` も出ない / **plan 後に対象を消して apply** → **vault root** が出ない (このケースだけ出どころが `resolveForExistingRead` の `realpath` で、patch 読取の catch では塞がらない = 境界でしか止まらない) / サーバ自作の文言 (`Patch is stale` / `Document not found: …`) は**そのまま届く** (誤検知の逆)。
  ★ 逆検証で **2 層が独立**であることを実測する — 境界だけ外すと vault root のテスト**だけ**が赤 (`ENOENT: … /tmp/mcp-errleak-vault-…`)、各サイトの catch だけ外すと**文言の assert だけ**が赤で 封じ込めの assert は通る。片方を「もう片方があるから要らない」と消さない
- prompt injection fixture: 偽承認・tool-call風JSON・外部送信命令を忠実にdataとして返し、
  readだけでnote/patch stateを変更しない / invalid patch_idをreject / write tool annotationsをpin
- audit surface (INV-9): run_id traversal/charset/先頭記号をreject / append create-only (同一no-op・
  相違reject・既存を上書きしない) / CAS (初回sha256("")成功・誤expectedはstale・mutexで並行CAS直列化) /
  一般 document write が監査サブツリーを対象にすると reject (create=plan/apply, update=plan/apply権威) /
  scanエンドポイント (一般write off + audit on) は audit tool のみ露出し一般write toolは非登録
- **サーバ所有 frontmatter を書く側で拒否 (INV-2 write側 / INV-8・INV-9)**: report / state /
  Skill `references/*.md` が `id` や `updated_at` を宣言したら reject し、**ファイルは作られない** /
  **監査面はさらに `title` / `tags` 以外を全て reject** (`project` を宣言した report / state が
  reject され、read 面が読まない未知 key も reject される) / **主 assert は negative** —
  被害 project の genuine な state note を置いた vault で `get_project_state` を実際に回し、
  **攻撃者本文が応答のどこにも出ない**ことを見る (genuine が出ることの assert は、
  偽物が隣に並んでいても緑になる) /
  Skill は **plan の時点**で拒否 (apply だけだと承認用 diff を見せた後で止まる) /
  サーバ所有でない frontmatter・frontmatter 無しは**従来どおり通る** (誤検知の逆) /
  ★ **巨大な未終端ブロックを渡して経過時間を assert** — 書く側に frontmatter 検査を足したせいで
  二次 parse 経路を開け直していないことは、**時間でしか区別できない**

