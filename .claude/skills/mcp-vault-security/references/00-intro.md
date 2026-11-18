
# mcp-vault-security

`claude_openai_mcp_connector` のセキュリティ境界コードを触る前にロードする発火スキル。
このサーバは **private Markdown vault を MCP クライアント (LLM) に公開する**。脅威の
中心は「① vault の外へアクセスを逃がす path 攻撃」「② frontmatter/YAML への field
injection」「③ 既存ノートの破壊的/stale 上書き」「④ public repo への vault/secret 混入」
「⑤ vault 本文経由の prompt injection」。

