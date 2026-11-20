### INV-4 Public repo / private vault 分離

- `.gitignore` が `vault/` `knowledge/` `data/` `.env*` `.mcp-state/` `*.key` `*.pem`
  `credentials*.json` `*token*.json` `secrets/` を除外。
- vault を使うテストは**合成データのみ**。`fixtures/synthetic-vault/` または試験が一時ディレクトリに作るノートを使う (実 vault を fixture 化しない)。
- commit は**ファイル個別 add** (`git add src/... tests/...`)。`-A`/`.` 禁止。

