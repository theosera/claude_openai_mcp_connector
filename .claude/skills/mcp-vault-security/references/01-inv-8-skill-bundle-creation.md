### INV-8 Constrained Skill bundle creation

Skill は将来の agent 指示として実行されるため、一般ノート作成より狭く扱う:

1. `MCP_SKILLS_SUBDIR` は primary vault 配下の安全な相対パスに限定し、起動時に containment と
   symlink escape を検査する。`MCP_HTTP_ALLOW_SKILL_WRITE=1` だけでは subdir 未設定なら起動拒否。
   **★ 予約と tool 登録は別の決定 — 全 transport で独立 opt-in が要る** (INV-9 item 1 と同型)。
   `MCP_SKILLS_SUBDIR` は「このサブツリーを一般 write から予約する」だけ。Skill write tool を
   **登録**するのは HTTP = `MCP_HTTP_ALLOW_SKILL_WRITE` / stdio = **`MCP_STDIO_ALLOW_SKILL_WRITE`**
   (既定 off、`src/config.ts` の `stdioAllowSkillWrite` → `src/index.ts` の `allowSkillWrite`)。
   stdio は以前 `Boolean(skillStore)` で登録していたため、**「write 可能な全 process に subdir を
   設定せよ」という運用指示に従うと、untrusted vault content を読む interactive セッションに
   `plan_skill_create` が生えた** (#113)。予約は `config.skillsSubdir` → `createStore` 経由なので、
   **tool を外しても INV-8 は効き続ける**。stdio 起動行は 3 状態を出す:
   `skills=off` (subdir 無し = 予約なし) / `skills=reserved-only` (既定) / `skills=on`。
   `MCP_STDIO_ALLOW_SKILL_WRITE=1` で subdir 未設定なら**起動拒否**。
   ⚠️ **audit pair と同一視しない。** あちらは plan/apply の無い single-call write だが、Skill 作成は
   二段階なので確認を経る。**それでも gate が要る理由は別にある** — **Skill は後続セッションが
   「指示として」読み込む**もので、監査レポートは data として読み戻される。
   ★ **ワイヤ上で実測済み** (2026-09-02 JST、両 transport の 2×2): subdir のみなら
   `skills=reserved-only` で **stdio 12 / HTTP 8 tools のどちらにも `plan_skill_create` は出ない**。
   flag も立てると **stdio 14 / HTTP 10** になり、実際に呼べる。**flag だけ (subdir 無し) は起動拒否。**
   ⭕ HTTP 側は `documents=off` のまま **8 → 10** なので、item 4 の「後者だけでは一般 document
   write を出さない」もワイヤで確認できている。
2. 必ず `plan_skill_create` → bundle diff のユーザ承認 → `apply_planned_skill_create`。plan は
   target を触らず patch state に proposal だけを保存する。
3. 許可ファイルは `SKILL.md`、flat `references/<lowercase>.md`、`agents/openai.yaml` のみ。
   scripts/assets/nested references/任意パス/NUL/過大 bundle を拒否する。
4. `SKILL.md` frontmatter は `name` と `description` だけを許可し、name は directory 名と一致。
5. create-only: 既存 Skill は上書きしない。全ファイルを Skill root 内の一時 directory に
   exclusive create し、完成後に同一 filesystem の rename で atomic publish する。
6. **★ reference files はサーバ所有 frontmatter を名乗れない** (`assertNoServerOwnedFrontmatter`)。
   `SKILL.md` は 4 で `name`/`description` に固定済みだが、**`references/*.md` は素通りだった** —
   bytes がそのまま vault に着地し、他の note と同じく document として index されるので、
   他文書の `id` を宣言してその lookup を奪える。**INV-8 は「どこへ書けるか」を絞り、
   「何を名乗れるか」を絞っていなかった。**
   検査は **`validateFileSet`** に置く — **plan と apply の両方**が終端するのはここだけ。
   apply だけで拒否すると、**承認用の diff をユーザーに見せた後**で止まることになる
   (squat は「適用されない」ではなく「表現できない」でなければならない)。

