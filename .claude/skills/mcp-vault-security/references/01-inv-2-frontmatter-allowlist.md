### INV-2 Frontmatter field allowlist — YAML injection 防止

`plan_document_update` の `frontmatter_patch` は**クライアント (LLM) 由来の untrusted
入力**。`src/frontmatter.ts::assertFrontmatterPatch` が許可キー
(`PATCHABLE_FRONTMATTER_KEYS` = `client` / `project` / `title` / `tags` / `source_refs`)
以外を reject。`id` (同一性) と `updated_at` (サーバ stamp) は patch 不可。未知キーを
黙って通すと frontmatter に任意フィールドを注入できてしまう。**値型も検証**する
(`validatePatchValue`: `client`/`project`/`title` = string、`tags`/`source_refs` = string[])
— キー allowlist だけでは nested object / 型不一致を YAML に注入できてしまうため。

**★ 読む側も同じ不変条件に属する: `id` は同一性ではない。** `readDocument` は
`document.id` を**ファイル自身の frontmatter から verbatim**に取る。frontmatter は untrusted
vault content (INV-5) なので、1 枚のノートが**他文書の uuid や他文書の path** を `id` として
宣言でき、id-first の lookup を無条件に奪える (`fetch_document` / ChatGPT `fetch` /
`trace_sources` / **`plan_document_update` の対象解決**)。二段階書き込みは「承認した**内容**」を
守るが「承認した**対象**」は守らない。したがって **`fetch` は参照が文書を 1 つだけ指すときにのみ
解決する** (`resolveUniqueReference`) — id 名前空間と path 名前空間をまたいで 2 つ以上が
名乗ったら **fail closed** (先頭一致を返さない)。

- **path 優先にしない。** path を先に解決すると、その id を運んできた citation が指すのとは
  **別の文書**を黙って返す (= `MultiRootStore.fetch` の id-first が防いでいた mis-route)。
- **★ 到達性は失う。それを認めた上で refuse を採る。** 「exact な vault-relative path なら
  content が名乗れない」は**偽** — frontmatter `id` は path を名乗れるし、それが主要な攻撃形。
  自前の uuid を持つ文書は uuid で引けるが、**frontmatter `id` を持たない文書は handle が path
  1 本だけ** (id = path) なので、その path を squat されると**引く手段が無くなる**。
  両方テストで pin 済み。**エラーは「exact path で引き直せ」と言わない** (同じ衝突に着地するため) —
  言うのは「重複 `id` を消せ」。
- **ガードは 2 箇所ある**: `KnowledgeStore.fetch` と `MultiRootStore.fetch`。**片方が正しいことは
  他方の証拠にならない** — primary root の squatter は read-only root の文書を奪えるが、その衝突は
  **composite からしか見えない**。両方を踏むテストで pin する (`tests/knowledgeStore.test.ts`)。
- **代償を隠さない**: 偽装ファイル 1 枚で、被害文書も**曖昧として引けなくなる** (loud な DoS)。
  黙って攻撃者の本文を返すより良い、という判断。エラーは衝突相手を `relativePath` で名指しする
  (`absolutePath` は出さない)。

**★ frontmatter は parse する前に長さで縛る (`MAX_FRONTMATTER_BLOCK_BYTES` = 8 KiB)。**
`matter()` の実行中に**二次の CPU 経路が 2 つ**走る — ① gray-matter の comment stripper
(`/^\s*#[^\n]+/gm`。`m` なので**行頭の数**が効き、LF だけでなく U+2028/U+2029 も行頭を作る)
② js-yaml の `!!omap` (**GHSA-5p4m-2wfm-xmqj** / `gray-matter > js-yaml` = **本番依存**)。
実測 (gray-matter 4.0.3 / js-yaml 3.15.0): **終端なし 391 KB で 101.8 秒**、`!!omap` 1,228 KB で 3.5 秒。
**終端 `---` が無いと gray-matter はファイル全体をブロック扱いする**のが最悪ケース。

- **結果を見るガードでは間に合わない。** `assertBoundedFrontmatterExpansion` は `matter()` が
  返った後に走るので、この経路を一度も止めていない。**両者は補完関係**であり、片方を理由に
  もう片方を消さない — ブロック長上限は展開爆弾に対しては**正しく却下**された (爆弾は数百バイト)。
- **経路①は依存更新で直らない (gray-matter 自身のコード)。経路②は直る。**
  js-yaml **3.15.1** は patched で gray-matter の `^3.13.1` の**レンジ内**、`pnpm.overrides` で pin 済み。
  → **経路②にとって上限は mitigation ではなく defence in depth**。mitigation と呼び続けると
  **古い js-yaml が許容可能に見える**。
  ⚠️ **advisory は構造化フィールドを読む** — このレコードはタイトルが
  _"CVE-2026-59870 fix not backported"_ なのに、同じレコードの `patched_versions` が `>=3.15.1`。
  タイトルを読んで「5.x のみ」と 4 文書に書いた (本ファイル含む) のがこの誤り。
  ⚠️ **`pnpm update` は transitive を動かさない** — lockfile がレンジを満たしていると見なすため。
  override だけが動かす。
- **上限は実データで決める** (実 vault 2,381 ノート / median 225 B / max 1,042 B → 8 KiB で 7.9 倍の余裕)。
  ⚠️ **この倍率は as-of 付きの値で、cap でなく「最大のノート」の性質なので、誰もコードを触らなくても腐る。**
  **2026-09-01 再測** (その日サーバが索引していた 2,801 files / frontmatter 保持 2,462 / ガードと同じ数え方。
  ⚠️ **件数は 1 時間のうちに 181 動いた** — これは「この標本の分母」であって「vault の大きさ」ではない):
  median 272 B / max **1,771 B** → **4.6 倍**。over-cap 0 件・unterminated 0 件なので **cap は据え置き**。
  ⇒ **倍率を引く前に最大値を測り直す。**
  **文字種を列挙しない** — 何で埋められても長さで止まる (`D-G2-REDOS` の一般化)。
- **超過は必ず出力する。** read 経路は `parseError` → ファイル名付きで stderr、本文のみ index。
  write 経路は throw (frontmatter を黙って落とすとデータ損失)。
  **★ これは「書く直前の parse」だけでなく「書く内容を組み立てる parse」にも効く。**
  `planUpdate` は現本文を parse して patch をマージするので、**`parseMarkdownSafe` ではなく
  `parseMarkdown`** を使う (2026-08-11 の外部レビュー指摘)。safe 版は失敗時に**空 frontmatter へ
  縮退**するので、壊れた YAML / 上限超過のノートを更新しようとすると**読めなかった全フィールドを
  削除する diff** が組み上がり、承認者にはそれが意図した変更に見える。**read は「そのノートを
  返し続ける義務」があるから縮退してよい。writer にその義務は無い。**

