### INV-3 Two-step stale-safe write

既存ファイル編集は必ず 2 段階:

- `plan_document_update`: diff + `expected_sha256` (plan 時の現本文ハッシュ) を
  `<MCP_PATCH_STATE_DIR>/<uuid>.json` に保存 (既定は
  `~/.mcp-state/patches-<primary root の hash>`)。**ファイルは触らない**。
- `apply_planned_update`: 現本文を再ハッシュし `expected_sha256` と照合。**不一致なら
  「stale」で適用拒否** (plan 後に外部編集が入ったら上書きしない)。`patch_id` は UUID
  形式を検証 (`patchPath`) — patch_id 経由で任意ファイルを読まないため。
- exact-path 新規作成は `plan_document_create` → 完全なdiff/対象パス提示 → **現在のユーザへ
  `保存先は「…」でよろしいですか？` を `はい` + 自由記述で確認** →
  `apply_planned_document_create`。apply は `confirmed_target_path` の完全一致と staged content
  の sha256 を検証する。自由記述でパス修正なら apply せず再 plan。plan は対象/親dirを作らない。
- 全新規作成 (`createDocument` / exact-path apply) は `flag: "wx"` で**既存を上書きしない**
  (EEXIST → エラー)。親dirは component ごとに symlink/non-directory を検査してから作る。
- **★ 上書きする唯一の write は atomic に置換し、直列化する** (`src/atomicWrite.ts` の
  `replaceFileAtomically` = 同一ディレクトリ temp → 所有者/権限を復元 → rename)。in-place
  `writeFile` は truncate してから書くので、中断でユーザのノートが**途中書き**になる
  (vault に控えは無い)。read→hash→write は `serializeWrite` で直列化 — 同一 plan 基点の
  apply が 2 本走ると**両方が非 stale と判定して後勝ちで消える** (承認した diff と違う結果)。
  ⚠️ **範囲を誇張しない**: atomic ≠ durable (fsync していない — 他 3 writer と同条件)、
  in-process ≠ cross-process (別プロセス同士は依然競合し、防ぐなら on-disk lock が要る)。
- **★★ 置換は「書き込み」と権限要件が違う。3 つとも弱めない**:
  1. **要るのはディレクトリの write 権限**で、ファイルの所有権ではない。in-place はファイル
     権限だけで足りていたので、**共有ディレクトリでは挙動が変わる**。エラーは**どの権限が
     足りないかを名指しする** (生 `EACCES` を出さない)。⚠️ **in-place へフォールバックしない** —
     それが塞いだはずの torn write そのもの。
  2. **所有者を復元できなければ rename しない (fail closed)。** rename は**対象を所有していなくても
     ディレクトリ write だけで通る**ので、他ユーザのノートを自分所有の temp で置換でき、
     `chown` を戻せないと**静かに所有者が移る**。「その所有者になれないなら元々置換もできない」は
     **偽** — 2026-08-11 の外部レビューで指摘され、実際に誤っていた。temp の uid/gid が
     **既に一致するときだけ** `chown` を省く。
  3. **temp は handle 経由で stat/chown/chmod する** (path で check→use しない)。作成は
     `mode` 付き `wx` → 完了後に `chmod` で厳密化 (open flag は umask に削られ、`chmod` だけだと
     **書込中に既定 mode で存在する窓**ができる)。失敗時は**どの経路でも、自分が作った** temp を掃除する。
     ⚠️ **「自分が作った」が要る** — 作る段 (`wx`) と書く段を分け、**作る段が失敗したら何も消さない**。
     その名前に在るもの (EEXIST) は他人の entry で、この呼び出しの debris ではない。旧版は `writeFile(…wx)`
     1 回の失敗を理由を見ずに `rm(temp, { force: true })` していた (試験は 1 本もその経路を踏んでいなかった)。
- **★ 一段階 write は既定 off** — `create_document` だけは plan/apply 対を持たないので
  `MCP_ALLOW_LEGACY_CREATE_DOCUMENT` (**両 transport 共通・既定 off**) を要求する。
  path 封じ込め・`wx`・サーバ生成 `id` は効いているので **identity 奪取や上書きはできない**が、
  承認無しで `projects/` に任意本文を**永続化**でき、それが後続セッションで untrusted
  vault content として読み戻される。`scripts/check-http.mjs` では独立カテゴリとして採点する
  (general write に混ぜると、その flag を検査しないのと同じになる)。

