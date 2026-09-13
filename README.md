# nhtsa-recalls-mcp

A remote **Model Context Protocol (MCP)** server that gives Claude, ChatGPT, Cursor, or any MCP client
read-only access to the US NHTSA public vehicle-safety datasets: VIN decoding, safety recalls, owner
complaints, and 5-Star (NCAP) safety ratings.

Runs on **Cloudflare Workers** as a stateless streamable-HTTP server. No database, no API keys for the
data (NHTSA's APIs are public), one file of config, one command to deploy.

Built by Dylan Lane ([Chucks-Lab](https://github.com/chucks-lab)) as a reference implementation of the
pattern most businesses actually need: a small, allowlisted, read-only MCP server in front of an existing
API, with logging, upstream error handling, and an optional bearer token.

```
Claude / ChatGPT / Cursor  --(MCP over HTTPS)-->  Cloudflare Worker  --(HTTPS)-->  api.nhtsa.gov, vpic.nhtsa.dot.gov
                                                   /mcp    MCP endpoint (POST)
                                                   /health JSON status + tool list
```

## Tools

| Tool | What it does |
|---|---|
| `decode_vin` | Decode a VIN with NHTSA vPIC: make, model, year, trim, body class, engine, fuel type, plant, GVWR, decode warnings. |
| `list_models` | The model names NHTSA uses for a make and year (recalls or complaints catalog). Use it to get spellings right. |
| `get_recalls` | Recalls for make/model/year: campaign number, date, component, summary, consequence, remedy, park-it / park-outside / OTA flags. Newest first. |
| `get_recall_by_campaign` | One recall by campaign number (e.g. `24V935000`) with every vehicle it covers. |
| `get_complaints` | Owner complaints for make/model/year: total, crash/fire/injury/death counts, top components, most recent complaints. Filter by component. |
| `get_safety_ratings` | NCAP ratings for make/model/year. Lists rated variants (2WD/4WD, cab styles) or returns the full rating when there is one. Suggests spellings when the model name misses. |
| `get_safety_rating_by_id` | Full 5-Star ratings for one rated variant by NHTSA VehicleId. |

Every tool is annotated `readOnlyHint: true`. Each returns a readable text block plus `structuredContent`
JSON for clients that use it.

Example prompts once connected:

- "Decode VIN 5YJ3E1EA7KF317000 and list its open recalls."
- "How many complaints does a 2019 Ford F-150 have about the transmission? Show the three most recent."
- "Compare the NCAP ratings of the 2019 F-150 SuperCrew 4x2 and 4x4."

## Try the public instance

- Health: `https://nhtsa-recalls-mcp.<your-subdomain>.workers.dev/health`
- MCP endpoint: `https://nhtsa-recalls-mcp.<your-subdomain>.workers.dev/mcp`

**Claude (web or desktop):** Settings -> Connectors -> Add custom connector -> paste the `/mcp` URL.
**Claude Code:** `claude mcp add --transport http nhtsa https://<host>/mcp`
**Cursor:** add `{ "mcpServers": { "nhtsa": { "url": "https://<host>/mcp" } } }` to `mcp.json`.

## Deploy your own (5 minutes)

Requirements: Node 20+, a Cloudflare account (the free plan is enough), `npx wrangler login` done once.

```bash
git clone https://github.com/chucks-lab/nhtsa-recalls-mcp
cd nhtsa-recalls-mcp
npm install
npm run dev        # local server on http://127.0.0.1:8787
npm test           # 11 unit tests against recorded NHTSA responses (no network)
npm run test:e2e   # real MCP client against the local server and live NHTSA data
npm run deploy     # wrangler deploy -> prints your workers.dev URL
```

On Windows PowerShell where `npm run` wrappers are blocked, call the tools directly: `npx.cmd wrangler dev`,
`npx.cmd wrangler deploy`, `npx.cmd vitest run`.

## Configuration

All settings live in `wrangler.jsonc` under `vars`, except the secret.

| Setting | Default | Meaning |
|---|---|---|
| `ALLOWED_TOOLS` | all seven | Comma-separated allowlist. Remove a name and the tool disappears from `tools/list`. |
| `UPSTREAM_TIMEOUT_MS` | `8000` | Per-request timeout for NHTSA calls (clamped 1000-25000). One retry with backoff on 429, 5xx, timeouts and network errors. |
| `LOG_LEVEL` | `info` | `debug` adds one log line per upstream call (URL with VIN masked, status, latency). |
| `MCP_BEARER_TOKEN` | unset | **Secret.** When set, every `/mcp` request must send `Authorization: Bearer <token>`; otherwise the server is public (the data is). |

### Locking it down with a bearer token

```bash
openssl rand -hex 32 | npx wrangler secret put MCP_BEARER_TOKEN
```

Then add the header in your client. Claude custom connectors support a bearer token field; Claude Code:
`claude mcp add --transport http nhtsa https://<host>/mcp --header "Authorization: Bearer <token>"`.

### Rotating the secret

1. `openssl rand -hex 32 | npx wrangler secret put MCP_BEARER_TOKEN` (takes effect on the next deploy-less
   reload, usually within seconds).
2. Update the token in each client.
3. Old token stops working immediately; there is no dual-token window by design. If you need one, add a
   second secret (`MCP_BEARER_TOKEN_PREVIOUS`) and accept either in `src/index.ts` for the rotation window.

Never commit tokens. `.dev.vars` (for local `wrangler dev`) is git-ignored.

## Logs and observability

Workers Logs are enabled in `wrangler.jsonc` (`observability.logs`). Every request emits one JSON line:

```json
{"ts":"2026-09-13T02:37:38.205Z","requestId":"<cf-ray>","path":"/mcp","method":"POST","event":"request","status":200,"ms":7,"tools_enabled":7,"tools_total":7}
{"ts":"...","requestId":"<cf-ray>","event":"tool","tool":"get_recalls","ms":412,"ok":true}
```

Tail live: `npx wrangler tail`. Upstream failures log `event: "tool", ok: false, upstreamStatus: 503` and
return an MCP tool result with `isError: true` and a plain-English message, never a protocol error.

## Design notes

- **Stateless per request.** `createMcpHandler` from `@modelcontextprotocol/server` builds a fresh
  `McpServer` for every HTTP request; nothing is held between calls, so the Worker scales to zero and
  needs no Durable Objects.
- **Allowlist, not blocklist.** The server only ever registers the tools named in `ALLOWED_TOOLS`. A hidden
  tool cannot be called.
- **Read-only by construction.** There is no code path that writes anywhere. Adding a write tool is a
  deliberate change, not a flag.
- **Upstream quirks handled.** NHTSA returns DD/MM/YYYY dates from the recalls API and MM/DD/YYYY from the
  complaints API; the ratings dataset spells models differently ("F-150 SUPER CREW"). The server sorts
  correctly and suggests spellings instead of returning empty results.
- **Two Workers gotchas already fixed for you.** Calling a stored global `fetch` throws "Illegal invocation"
  (wrap it), and `new Date()` at module scope reads as 1970 (compute inside the request).

## Project layout

```
src/index.ts    Worker entry: routing, bearer auth, request logging
src/server.ts   MCP server factory: tool definitions, allowlist, formatting
src/nhtsa.ts    NHTSA HTTP client: timeouts, retry, date parsing, VIN masking in logs
test/           vitest unit tests with recorded fixtures; e2e-client.mjs for a live run
wrangler.jsonc  Worker config and non-secret settings
```

## Data source and disclaimer

Data comes from the US National Highway Traffic Safety Administration public APIs (api.nhtsa.gov and
vpic.nhtsa.dot.gov). This project is not affiliated with NHTSA. Recall and complaint data can lag and
complaints are unverified consumer reports; confirm safety-critical information with the manufacturer or
at nhtsa.gov/recalls.

## License

MIT. See `LICENSE`.
