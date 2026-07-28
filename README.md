# JustAskMyAI

“我不知道怎么和你说，你的 AI 去问我的 AI。”

This repository is an early Node.js proof of architecture. It is intentionally a thin bridge over MCP, A2A, and existing agent runtimes.

## Run

```bash
npm install
npm run check

# terminal 1
$env:JAMAI_POLICY="auto"
npm run dev:node

# terminal 2 (MCP stdio server)
npm run dev:mcp
```

Default node URL: `http://127.0.0.1:43120`.

Use an existing ACP agent instead of the mock:

```powershell
$env:JAMAI_ADAPTER="acp"
$env:JAMAI_ACP_COMMAND="hermes"
$env:JAMAI_ACP_ARGS='["acp"]'
npm run dev:node
```

The same adapter can launch `codex-acp`, `claude-agent-acp`, Copilot ACP, or another
ACP server by changing the command and JSON argument array. ACP tool permissions
remain denied unless the local owner sets `JAMAI_ACP_ALLOW_TOOLS=true`.

Useful local endpoints:

- `GET /health`
- `GET /api/peers`
- `POST /api/peers`
- `GET /api/approvals`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/deny`
- `GET /.well-known/agent-card.json`

See [architecture](./docs/architecture.md).

For real work across two machines, follow the
[two-computer collaboration test](./docs/two-computer-test.md).
