### INV-6 Remote HTTP transport — authn + 露出最小化 (fail-closed)

private vault を HTTP で公開する経路は新しい攻撃面。以下を**弱めない**:

1. **bearer auth 必須** — 全 HTTP リクエストは `Authorization: Bearer <MCP_AUTH_TOKEN>` を
   要求。照合は `src/httpAuth.ts` で**constant-time** (`timingSafeEqual`、両辺を sha256 で
   固定長化して length 差で早期 return しない)。`MCP_AUTH_TOKEN` 未設定なら
   `loadHttpConfig` が**起動拒否** (open endpoint を作らない)。不正/欠落は 401。
2. **loopback bind 既定** — `MCP_HTTP_HOST` 既定 `127.0.0.1`。公開は明示トンネル経由のみ。
   `0.0.0.0` を既定にしない。
3. **DNS-rebinding 防御** — `src/httpServer.ts` の `rejectRebinding` が
   **エンドポイント境界で、era 分岐より前に**検査する (transport の deprecated option は使わない —
   modern leg (`createMcpHandler`) には同等の option が無く、境界で 1 回検査することで**両 era を
   同一に**守る)。Host は SDK の `validateHostHeader` = **hostname 比較・port 非依存**で、
   `MCP_HTTP_ALLOWED_HOSTS` の `host:port` 表記は `hostnameOf` で port を剥がす (env 契約を維持。
   D-M3A-HOST-PORT: サーバは 1 port しか listen しないので port は識別子として無意味)。
   Origin は **完全一致 (scheme 含む)** を自前で維持する — SDK の `validateOriginHeader` は
   hostname のみで `https`/`http` を区別しなくなるため**採用しない** (D-M3A-ORIGIN-EXACT)。
   `MCP_HTTP_ALLOWED_ORIGINS` 未設定なら Origin 検査はスキップ、設定時も **Origin 無しは通す**
   (D-M1-ORIGIN-ABSENT)。トンネル公開時は公開ホストを allowlist に追加 (`MCP_HTTP_PUBLIC_URL`
   は `loadHttpConfig` が自動追加)。検査対象は `/mcp` のみ。
4. **read-only 既定 + per-request 解決** — write tool は対応する許可がないとき
   **registerTool 自体を呼ばない** (discover もさせない)。document write は `MCP_HTTP_ALLOW_WRITE`、
   constrained Skill create は `MCP_HTTP_ALLOW_SKILL_WRITE` で独立して opt-in。後者だけでは一般
   document write を出さない。stdio は `serveStdio` で両 era を同一 factory から提供するが、
   **「full」なのは二段階の document write だけ**で、legacy create (INV-3) / Skill (INV-8 item 1) /
   audit (INV-9 item 1) は**それぞれ独立の stdio opt-in**を要る。**ここに写しを置かない。**
   **HTTP に session は無い** (`createMcpHandler` の `legacy: 'stateless'` で 2025 era も per-request)。
   scope→tool 面の導出は **`surfaceFor` 1 箇所**で、**両 era・全リクエスト**がそこを通る。
   principal を復元できなければ factory は **throw して fail-closed** (既定の tool 面を作らない —
   その既定は full になってしまう)。**session を再導入しない** — session id だけで routing すると
   提示 principal の再確認が消え、write scope で開いた接続が寿命の間 write 面を保持してしまう
   (2b が閉じた穴そのもの)。
   **stdio は逆に接続ごとに 1 instance を pin する** — これは HTTP の穴の再導入ではない。HTTP は
   同一接続の後続リクエストが**別の bearer を提示しうる**から per-request 解決が要る。stdio は
   principal を運ばない (`serveStdio` は `ctx.authInfo`/`ctx.requestInfo` を設定しない)、相手は
   自プロセスを spawn した側で、面は定数 — pin と per-request が観測上同一。**対称性を理由に
   どちらかをもう一方へ合わせない** (stdio を per-request 化しない / HTTP に pin を戻さない)。
5. **body サイズ上限** — `readBody` が `MAX_BODY_BYTES` を超えたら 413 (JSON / form 双方の入口)。
6. token / vault 本文を**ログに出さない** (stderr の起動行は host:port と write 可否、それに
   OAuth 有効時だけ状態ごとの登録件数 `registrations=given:N,pending:N,unknown:N` のみ。#184:
   旧 state file から持ち込んだ `unknown` が枠を埋めていることは件数でしか見えない)。
   **件数以外 (client_id・redirect URI・token・パスワード) を起動行に足さない** —
   `tests/config.test.ts` の起動行の試験が、それらが出ないことを spawn した実 entrypoint で見ている。
   secret は env のみ (INV-4 と同じ規律)。

