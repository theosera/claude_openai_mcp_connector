### INV-9 Constrained audit write surface (監査証跡の完全性)

無人スキャナが監査レポート/state を vault に残すための、**単一サブツリー限定**の append + CAS
surface (`src/auditStore.ts`)。**注意**: 無人・書込許可の走査による confused-deputy を塞ぐのは
INV-9 ではなく**エンドポイント分離** (走査エンドポイントに一般 write tool をそもそも登録しない)。
INV-9 の役割は**監査証跡の完全性** = 一般 write surface が監査ファイルを改竄/上書きできないこと。
**弱めない**:

1. `MCP_AUDIT_SUBDIR` は primary vault 配下の安全な相対パスに限定し、起動時に containment +
   symlink escape を検査 (`resolveInsideRoot` + `realpath` + `relativeToRoot`)。
   `MCP_HTTP_ALLOW_AUDIT_WRITE=1` だけでは subdir 未設定なら**起動拒否**。`loadConfig` は監査
   subdir が `projects/` (create-root) と **disjoint** かを boot で assert。
   **★ 予約と tool 登録は別の決定 — 全 transport で独立 opt-in が要る。** `MCP_AUDIT_SUBDIR` は
   「このサブツリーを一般 write から予約する」だけ。audit tool を**登録**するのは HTTP =
   `MCP_HTTP_ALLOW_AUDIT_WRITE` / stdio = **`MCP_STDIO_ALLOW_AUDIT_WRITE`** (既定 off、
   `src/index.ts` / `AppConfig.stdioAllowAuditWrite`)。stdio は以前 subdir の存在だけで
   登録していたため、**「write 可能な全 process に subdir を設定せよ」という運用指示に従うと、
   untrusted vault content を読む interactive セッションに append/CAS が生えた** (2 つとも
   plan/apply 無し・確認無しの single-call write なので、予約があっても直接 forge/clobber
   できる)。予約は `config.auditSubdir` → `createStore` 経由なので、**tool を外しても INV-9 は
   効き続ける** — テストで両方 pin (`tests/stdio.test.ts` の "withholds the audit write tools"
   と直後の予約テストが同じ env を踏む)。stdio 起動行は 3 状態を出す:
   `audit=off` (subdir 無し = 予約なし) / `audit=reserved-only` (既定) / `audit=on`。
   `MCP_STDIO_ALLOW_AUDIT_WRITE=1` で subdir 未設定なら**起動拒否**。
2. `append_audit_report` は `reports/<run_id>.md` に **create-only** (`0600`)。中身は先に `reports/` の
   temp (`.report-<uuid>.tmp`・`.md` で終わらない) に書き切ってから `fs.link` で最終の名前に置く
   (既に何か在れば EEXIST・link は辿らない。`rename` は既存を上書きし、`copyFile` は写す途中で切れうるので使わない)。
   temp は**自分が作ったもの**だけを、どの道でも消す (作る段 `fs.open(temp, "wx", 0o600)` が失敗したら何も消さない)。
   `reports/` の `.report-*.tmp` は **audit の write tool を登録する process (`audit=on`) だけ**が起動時に掃除
   (`sweepReportTemps`)。⛔ `init()` に置かない — `init()` は予約だけの process でも走り、その process は書き手の
   append の途中で起動しうるので、書きかけの temp を消して書き手の link を ENOENT にする (#323 の Codex P2)。
   ⚠️ `.state-*.tmp` の掃除は今も `init()` の中で、同じ形を持つ (#323 より前から・別件)。⛔ 旧版は最終の名前へ直接 `writeFile(…wx)` していたので、
   書く段の失敗で**途中まで書かれた report が最終の名前に残り**、同じ `run_id` の送り直しを相違として拒み続け、
   walk がそれをその run の report として索引した。**hard link を作れない FS では**、audit の write tool を
   登録する process (`audit=on`) は起動時に `reports/` で 1 回 link を試して起動を拒み、実行中の link の失敗は
   その append を失敗にする (直接書く形へ戻らない)。予約だけの process (`audit=reserved-only`) は試さない —
   試すと hard link の無い FS の運用者が `MCP_AUDIT_SUBDIR` を外す方へ押され、INV-9 の予約が消える。
   EEXIST は同一内容なら idempotent no-op、相違なら reject (**上書きしない**)。`run_id` は厳格
   パターン (先頭英数字・`/`/`..`/NUL 不可) で reports/ 外へ出られない。
3. `compare_and_swap_audit_state` は `state.md` を **sha256 CAS** (読んだ版と一致時のみ更新、
   不一致は stale reject)。初回は `sha256("")`。書込は tmp+rename + `0600`。
   **★ 3b. report / state が frontmatter で名乗れるのは `title` / `tags` だけ**
   (`assertAuditWritableFrontmatter`、`assertWritableText` 内 = **両 writer の共通 choke**。
   後から 3 本目の writer を足しても自動で通る)。監査ファイルは `.md` として index されるので、
   **「監査サブツリーに閉じ込めた」はバイトの着地先については真、read 面が誰の同一性として
   返すかについては偽**だった (audit-write だけを持つ principal が vault 内の任意の note を
   名乗れた)。
   **★ 同じ穴が「同一性」だけでなく「帰属」にも開いていた** — `id` / `updated_at` を塞いだ
   段階では `project` / `client` / `tags` / `target_repo` / `source_refs` が素通りで、read 面は
   **まさにその key を designation として読む**。`project` + state tag を宣言した report を
   `get_project_state` が **`state_docs` に全文で**返し、tool 自身がそれを「owner が state として
   designate した note」と説明した (`list_projects` は victim project の作業として数えた)。
   **denylist でなく allowlist にする** — `toPublicDocument` が delete でなく allowlist である理由と
   同じで、後から read 面が読み始めた key が既定で拒否される。承認つき二段階の
   `frontmatter_patch` ですら 5 key の allowlist なのだから、**承認の無い single-call 面が
   それより広くてはならない** (むしろ狭い: `title` / `tags` は自己記述で、project を名乗れない
   文書上の tag は何も designate しない — `get_project_state` は `project` で先に絞るため)。
   ⚠️ **「designate しない」は「不活性」ではない。** ここは 2 度誤った — 最初は
   「confers nothing」、次は「呼び出し側が選ぶ signal だ」。**後者も過小**である:
   ① 呼び出し側が選ぶ filter (`search_documents(tags)` / `list_projects(tags)` /
   **`get_context(tags)` = 一致セクションを本文として返す**) に加えて、
   ② **誰も指定していない ranking 項**でもある — `scoreDocument` (`search.ts`) は
   query term が tag に一致するたび +5 するので、**tag を名指ししていない自由文検索**に
   snippet 込みで浮上する。③ 運用者が tag rule を設定していれば `get_context` で
   **重み付き `type`** が付く。**文書が自分で名乗れるのはここまでで、名乗れないのが
   designation** — 閉じたのはそれだけ。当たった結果は他の retrieval と同じ
   untrusted vault DATA (INV-5)。⚠️ **本文には届かない** — 本文中の markdown link は
   通常のグラフ辺になるので、`trace_sources` の backlink には現れうる。
   `tags` を残すのは自己記述のための意図的なトレードで、allowlist を広げる次の人に
   「tag は何もしない」と読ませない。
   **★ 判定は正規化前の生 key で行う** (`declaredFrontmatterKeys`) — `normalizeMetadata` は
   `tags` / `source_refs` を**常に** materialize するので、正規化後の key set では
   「宣言した」と「frontmatter が無い」を区別できず、**allowlist 検査が全 report を落とすか、
   さもなくば何も見ていないことになる**。
   **parse の順序は `parseMarkdown` と同一** (block cap → `matter()` → expansion cap) — report は
   512 KiB まで来るので、無界に parse すると N-C で塞いだ二次経路を**write 面に開け直す**。
   テストは throw だけでなく **経過時間も assert** する (cap 無しだと同じ payload で ~286 秒)。
   **parse 不能な frontmatter も reject** — read 側が degrade するのは既存 note を返す義務が
   あるからで、writer にその義務は無い。
4. append/CAS は **in-process mutex で直列化** — MCP はセッション内で並行 tool 呼び出しを
   pipeline するので、無人スキャナの read-hash-write がインターリーブして lost update するのを
   決定論的に防ぐ (`applyPlannedUpdate` の read→hash→write と同じ窓を閉じる)。
   ⚠️ **範囲を誇張しない**: mutex は 1 process の中だけ (`AuditStore` の promise の鎖)。監査サブツリーを
   共有する `audit=on` の process が 2 つあれば、`compareAndSwapAuditState` の read→compare→rename の
   間に共有の lock は無く、両方が同じ版を読んで CAS を通り、後の rename が先の更新を消しうる
   (INV-3 の「in-process ≠ cross-process」と同じ限り。防ぐなら on-disk lock が要る)。
5. **一般 document write は監査サブツリーを対象にできない** (`KnowledgeStore.assertNotAuditReserved`)。
   予約チェックは `resolveForWrite` (create_document / exact-path apply の共通 choke) と
   `applyPlannedUpdate` (update・**権威**) に置き、`planUpdate`/`validateCreateTarget` で早期 UX
   reject。**realpath 照合**で symlink/NFD/大文字小文字変種を無力化 (client 文字列だけで判定しない)。
   read (search/fetch) は除外しない — 監査ノートは fetch 可能に保ち、feedback-loop 対策は
   スキャナ側衛生に委ねる。

