### INV-4 Public repo / private vault 分離

- `.gitignore` が `vault/` `knowledge/` `data/` `.env*` `.mcp-state/` `*.key` `*.pem`
  `credentials*.json` `*token*.json` `secrets/` を除外。
- テストは `fixtures/synthetic-vault/` の**合成データのみ** (実 vault を fixture 化しない)。
- commit は**ファイル個別 add** (`git add src/... tests/...`)。`-A`/`.` 禁止。

