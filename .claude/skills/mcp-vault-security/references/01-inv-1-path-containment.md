## 不変条件 (invariants — 弱めない)

### INV-1 Path containment — vault 内の文書アクセスは各 knowledge root 配下

`src/pathSafety.ts` は相対パスと包含判定の共通部品。ファイルを読む・書く時点の検査は各 store が行う。多段ガード (順序を入れ替えない / 段を消さない):

1. **length cap** (`MAX_RELATIVE_PATH_LENGTH`) — payload 面積を縮める。
2. **前後の空白を除いた後の制御文字 / NUL 拒否** — `\x00-\x1f` `\x7f` を含むパスを reject。
3. **percent-decode 検証** — `%2e%2e` / `%2f` 等の encoded traversal を、decode 後に
   `..`/絶対化したら reject (downstream で decode されてすり抜けるのを防ぐ防御層)。
   ※ 操作には raw を使う。decode 結果は**検証専用** (実 fs 操作で `%20`→space 等に
   化けさせない)。
4. **NFC normalize** — macOS HFS+ の NFD 分解で `..` 判定を回避されないように。
5. **正規化後の行き先を検査**（`assertRelativePath` / `assertNoEscape`）。前後の空白を除き、元の表記と検査用に decode した表記の両方で、絶対パス・ホーム相対・正規化してカレントを指すものや二点で始まるものを拒む。途中の親参照は OS のパス正規化で畳む。
6. **解決時の包含検査**。`resolveInsideRoot` は候補の親の realpath を検査して末尾の名前を付ける。
   `relativeToRoot` は呼び出し元が渡したパスを root と比較する。末尾を含む realpath の確認は呼び出し側で行う。
7. **symlink escape 照合** (`walkMarkdownFiles` / `readDocument` / write 経路) — symlink は
   realpath して root 配下を確認、外を指すなら throw。
8. **symlink cycle 安全 (DoS 防止)** — `walkMarkdownFiles` は訪問済み realpath の `visited`
   set を持ち、再訪したら `[]` を返して打ち切る (`loop → root` で無限再帰させない)。escape
   照合 (7) は**温存** — cycle 対策の都合で root 外 symlink を通してはならない。

9. **`readDocument` は cache を見る前に毎回 realpath + `relativeToRoot` を通す。外さない。**
   ⚠️ **#108 で外した。マージ前に戻した。** 経緯を残すのは、外したくなる理由が強いから:
   呼び出し側 (`walkMarkdownFiles` / `resolveForWrite` / `resolveForExistingRead`) は
   同じ呼び出しでガードを通しており、**解決済みパスの二重解決に見える**。しかも
   **測定 (2,880 ノート / iCloud Drive) では全 stat 0.864 s に対し全 47.4 MB の読み込みは +0.23 s** —
   **コストは byte でなく per-file syscall** なので、外すと read tool 1 回あたり数千回分が浮く。
   ⚠️ **それでも外せない理由**: 「**同じ呼び出しで**」は「**同じ瞬間に**」ではない。walk がパスを
   集めてから読むまでの窓でディレクトリを root の外へ移して symlink で戻すと、**子ファイル自身の
   dev/ino/ctime/mtime は全て不変**なので (親の rename は子の ctime を動かさない)、
   **stat signature は本物の escape をまたいで一致し、root 外に解決されるパスの Markdown を返す**。
   独立した 2 者が検出 (Codex = P1 / CodeRabbit = マージ阻止)。
   その窓で返る bytes は**既に検証済み・キャッシュ済み**なので新規の開示は無い — しかし
   **INV-1 は「全ファイルアクセスが root 配下」と述べており、「窓の間だけ例外」は不変条件の弱体化**である。
   正しく塞ぐには fd ベースの封じ込め (`openat` / component ごとの `O_NOFOLLOW`) が要るが
   Node は移植可能な形で公開していない。**それができるまで、この安価な検査を残す。**
   `dev` は signature に残っているが**鮮度用**であり、封じ込めの代わりではない。

- walk 中に見つかった root 外への解決は例外を上げる。列挙後のファイルの再検査に失敗した場合、`readDocumentResilient` はそのノートを除き、残りの走査を続ける。
- **新しい read/write 経路を足したら必ずこのガードを通す**。root 外の生パスで `fs` を
  直接呼ばない。
- **複数ルート (`KNOWLEDGE_ROOTS`) でも各ルートが同ガードを持つ**: `src/multiRootStore.ts`
  は fs を直接触らず、ルートごとに無改変の `KnowledgeStore` を合成する。先頭ルートのみ
  書込可 — 非 primary ルート宛の write は fail-closed で拒否。ルートの入れ子/重複は
  `init()` で拒否 (同一ファイルが二重 identity を持ち read-only 境界を迂回するのを防ぐ)。
  参照の `name:` プレフィックスは**既知ルート名に一致した時だけ**剥がす (剥がした残りは
  子ストアの通常ガードを通る)。

> **検索の正規化は INV-1 と別物** (混ぜない): `src/searchText.ts` の NFKC folding は
> **照合専用**で、`fs` に到達しない。pathSafety の NFC は同一性保存が要件 (実 fs 操作に使う)、
> 検索側は意図的に lossy。片方の都合でもう片方を書き換えない。snippet は正規化テキストで
> 位置決めし**原文からスライス**する (本文を改変して返さない = INV-5)。
> `src/markdownLinks.ts::resolveRelativeLink` も純粋な文字列演算で、解決結果は
> **列挙済み document のパスとの比較にのみ**使う (生パスで `fs` を呼ばない)。root 外へ
> 出るリンクは `null` に落とし、相対リンクは root をまたいで一致させない。

