### INV-7 OAuth 2.1 authorization server (web client 用 / opt-in)

ChatGPT・Claude.ai web は user-pasted static bearer を受け付けず **OAuth 2.1 + PKCE +
DCR + metadata discovery 必須**。`src/oauth/` の最小単一ユーザ AS。**弱めない**:

1. **PKCE S256 必須** — `plain` を拒否 (`src/oauth/pkce.ts`、constant-time 照合、verifier の
   長さ/文字種を検証)。token 交換で verifier を challenge に照合できなければ `invalid_grant`。
2. **authorization code は単回・短命・束縛** — CSPRNG 256-bit、TTL (既定 60s)、`OAuthStore.consumeAuthorizationCode` で
   即削除 (再利用不可)、`client_id`/`redirect_uri`/`code_challenge` に束縛し token 時に再照合。
3. **redirect_uri は exact-match + scheme 制限** — 登録済み値と完全一致のみ。`https` か
   loopback `http` のみ許可 (`isAllowedRedirectUri`) = open redirect 防止。不正 client/redirect は
   **redirect せず** 400 ページ (誤リダイレクトで code を漏らさない)。
4. **login gate は slow-KDF + constant-time + fail-closed** — vault アクセスは共有パスワード
   (`MCP_OAUTH_PASSWORD`) で門番。低エントロピーな password は `verifyLoginPassword`
   (scrypt + `timingSafeEqual`) で照合し総当たりに計算コストを課す (高エントロピーな bearer
   token のみ単発 sha256 の constant-time 比較で可)。`MCP_OAUTH_ENABLED` 時に issuer URL
   (`MCP_HTTP_PUBLIC_URL`) かパスワード未設定なら `loadOAuthConfig` が**起動拒否**。
5. **token は opaque 256-bit + rotation + audience/scope 束縛** — access/refresh とも CSPRNG、
   TTL 失効、refresh は回転 (旧 refresh は**即時無効化ではない** — 60 秒の replay grace の間
   わざと生かし、その再提示で**自世代より上の**家系を revoke する。⛔ **提示 record 自身と
   同世代の access token は残る** — `revokeFamilyAbove` は `generation >` だけを消す。
   ⚠️ 60 秒は**上限**で固定ではない (`Math.min` で残 TTL に切り詰まる)。下の 7 を見よ)。token は **canonical resource `${issuer}/mcp`
   に audience-bound (RFC 8707)**。`/mcp` は static bearer **または** 「有効 access token かつ
   audience 一致」を受理 (`authenticate`)。401 時は `WWW-Authenticate: Bearer resource_metadata="…"`。
   **scope enforcement**: granted scope = 要求した scope があればサーバ許可との積集合、要求が空なら `vault.read`。`vault.write` は document・Skill・audit のいずれかの HTTP write surface が有効な場合に許可候補になる。**`vault.read` を持たない token は `/mcp` で
   `403` + RFC 6750 §3.1 `insufficient_scope` challenge で拒否**する (空の tool 一覧を 200 で
   返さない — 空 vault と区別が付かず、challenge が無いとクライアントは再認可できない)。
   **リクエストごとに** token scope と各 surface の flag を両方照合し、許可された tool だけを
   登録する (session に固定しない)。consent ページは **granted scope** (要求 ∩ 許可) を表示する。
6. **容量上限 + prune + DCR 入力上限 + consent hardening** — clients/codes/tokens を各上限で
   キャップし期限切れ掃除。**ただし client 登録を自動で消すのは「誰も同意していない登録」だけ**
   (#184、2026-10-01): 登録は `pending` で始まり、パスワード照合の後・code 発行の前に
   `given` になる (保存してから code を出す・保存は毎回)。`pending` は作成から 24 時間で
   `/register` と load のときに回収し、未認証の GET /authorize は期限を延ばさない。`given` と、
   旧 state file から読んだ `unknown` は**トークンが全部切れても消さない**。上限は全体 100・
   その内側に `pending` 20 で、どちらも満杯なら新規を `503` で拒否し、既存を追い出さない。
   ChatGPT は登録した `client_id` をアプリに保持して自分からは再登録しないので、消すと
   `400 Unknown client_id.` から戻れない (実測 2026-09-28)。**トークンの有無で消す sweep や
   cap eviction を戻さない**。⛔ **全部残す形 (A') にも戻さない** — 誰でも登録枠を永久に埋められる
   (change scan の F1)。DCR は redirect_uris 個数/長さ・client_name 長を制限。consent/login
   ページに `CSP frame-ancestors 'none'` + `X-Frame-Options: DENY` + `Referrer-Policy: no-referrer`。
   code/token/password を**ログに出さない**。
   HTTP の `handleOAuthRoute` は登録、ログインの POST、refresh rotation に個別の回数制限を適用する。rotation は成功時だけ枠を消費する。上限で拒むときも `observeRefreshReplay` が既存の再提示を判定する。
7. **state 永続化 (opt-in `MCP_OAUTH_STATE_FILE`) は hash-at-rest + 完全性検証 + fail-closed** —
   token は memory/disk とも **sha256(token) をキー**に保持 (state file に復元可能な secret を
   置かない)。file は atomic write (tmp+rename)・mode `0600`・dir `0700`。**HMAC-SHA256**
   (`MCP_OAUTH_PASSWORD` から scrypt 導出、per-file salt) で完全性を守り、改ざん/破損/version
   不一致/password 違いは**起動を拒む** (#263。詳細をログに echo しない)。store は `failed` の空のまま持ち
   (途中まで読んだ分も捨てる)、**`assertUsable()` が provider で throw** (自分で作った store にも渡された
   store にも)、**`persist()` は `failed` なら dir も temp も作る前に false** — **2 つは独立**で、片方を外しても
   他方が file を守る (試験も別々: 起動の拒否 = `refusal` / 保存の拒否 = `writeAnyway`)。absent (パスに何も無い)
   は従来どおり保存する。⛔ **#263 より前は「空 state で fail-closed」で起動し、次の save が file を置き換えて
   登録が全部消えた** — fail-closed は「不正な state を使わない」だけで「元の state を壊さない」を保証して
   いなかった。意図的な password 交換は「止める → 旧 state を vault の外へ退避 → 新 password で起動」で、
   検証の失敗を無視する常設の env は足さない (owner 決定 2026-10-02)。**読めない file
   (ENOENT 以外の読み取りエラー: EACCES / EISDIR / EIO) も空で始めず、起動を拒む** (#258。拒否は
   #263 で同じ `failed` + `assertUsable()` に寄せた) —
   読めない file (EACCES) で空で始めると、次の save の rename が file を置き換え (要るのは dir の write 権限だけ)、
   登録が全部消える。EISDIR は rename できないので消えないが、黙って空で動く点は同じ。
   親ディレクトリに入れない場合 (EACCES / ENOTDIR / ELOOP) は、store より先に `loadOAuthConfig` の path 照合が止める。
   メッセージは env 名と errno コードだけで、path も中身も出さない。**パスに何も無いときだけが初回** —
   行き先の無い symlink も ENOENT を返すので、`lstat` で何か在れば拒む (初回にすると最初の save の rename が
   symlink そのものを置き換え、行き先が戻っても二度と読まない)。⚠️ **行き先が在っても、save は link を
   通常の file に置き換える** (temp を path の隣に書いて rename で被せるため) — 運用者への案内は
   「`MCP_OAUTH_STATE_FILE` に実体の file の path を指す」であって「行き先を戻せ」ではない
   (#265 の Codex P2)。⇒ **state の path の最後の component が symlink なら、行き先の有無に関わらず
   起動を拒む** (#263・owner 決定 2026-10-02 の案 (a))。`O_NOFOLLOW` で開くので、確かめてから読むまでの
   間に link を差し込めない。⛔ **「link の先に書く」(案 b) を採らない** — 解いてから書くまでの窓を
   新しく開く (INV-1 と同じ種類)。代償: link で運用していた配置は更新後に起動しない (データは失わない)。
   親ディレクトリの link は従来どおり通る。auth code は
   **永続化しない**（単回、寿命は `MCP_OAUTH_CODE_TTL`、既定 60 秒）。**`rotateRefreshToken` の主な保存経路** (期限切れ / 未 rotate の
   client_id 不一致 / 回転成功) は**除去・遷移を即 disk 反映**する。⛔ **全 write 経路の話ではない** —
   例えば `validateAccessToken` の期限切れ除去は save しない。
   対応する refresh record が既になくても、有効な tombstone による失効処理で子孫を取り消した場合は保存を試みる。この経路で新しい token は発行しない。
   ⚠️ **単回性は維持していない** — 回転した refresh は 60 秒の replay grace の間わざと
   生き残る (上の 5)。**この 1 文は「即 disk 反映して単回性を再起動越しに維持」と書いていた**
   が、grace window が入った時点で後半だけが偽になった。**前半は主語を絞れば今も真。**
   ⭐ 訂正の根が「即時失効」でなく「有効範囲を書かなかったこと」である点を残す。
   load 時に期限切れを drop。⛔ **save 失敗は握り潰される** (警告のみで auth を壊さない) ので、
   「即 disk 反映」が保証するのは**試みた**ことであって、着地したことではない。

