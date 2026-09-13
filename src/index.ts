// Cloudflare Worker entry: routes /mcp to a per-request MCP handler, exposes /health,
// enforces an optional bearer token, and emits one JSON log line per request.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { NhtsaClient } from "./nhtsa.js";
import { ALL_TOOLS, buildServer, parseAllowedTools } from "./server.js";

export interface Env {
  ALLOWED_TOOLS?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  LOG_LEVEL?: string;
  /** Optional. Set with `wrangler secret put MCP_BEARER_TOKEN` to require Authorization: Bearer <token>. */
  MCP_BEARER_TOKEN?: string;
}

const VERSION = "0.1.0";

function logger(level: string | undefined, base: Record<string, unknown>) {
  const debug = (level ?? "info").toLowerCase() === "debug";
  return (event: Record<string, unknown>) => {
    if (!debug && event.event === "upstream") return; // upstream call detail only at debug level
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...base, ...event }));
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    const url = new URL(request.url);
    const started = Date.now();
    const log = logger(env.LOG_LEVEL, { requestId, path: url.pathname, method: request.method });

    // ---- plain HTTP surface -------------------------------------------------
    if (url.pathname === "/" || url.pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405, { allow: "GET, HEAD" });
      const allowed = [...parseAllowedTools(env.ALLOWED_TOOLS)];
      return json({
        name: "nhtsa-recalls-mcp",
        version: VERSION,
        status: "ok",
        mcp_endpoint: `${url.origin}/mcp`,
        transport: "streamable-http",
        auth: env.MCP_BEARER_TOKEN ? "bearer" : "none",
        tools: allowed,
        docs: "https://github.com/chucks-lab/nhtsa-recalls-mcp",
      });
    }

    if (url.pathname !== "/mcp") {
      return json({ error: "not found", hint: "MCP endpoint is /mcp; health is /health" }, 404);
    }

    // ---- optional bearer auth ----------------------------------------------
    if (env.MCP_BEARER_TOKEN) {
      const auth = request.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!token || !constantTimeEqual(token, env.MCP_BEARER_TOKEN)) {
        log({ event: "auth_reject", ms: Date.now() - started });
        return json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="nhtsa-recalls-mcp"' });
      }
    }

    // ---- MCP -----------------------------------------------------------------
    const timeoutMs = clampInt(env.UPSTREAM_TIMEOUT_MS, 8000, 1000, 25000);
    const allowedTools = parseAllowedTools(env.ALLOWED_TOOLS);
    const client = new NhtsaClient({ timeoutMs, retries: 1, log });

    const handler = createMcpHandler(() => buildServer({ allowedTools, client, log, requestId }), {
      legacy: "stateless",
      onerror: (err) => log({ event: "handler_error", message: err.message }),
    });

    try {
      const res = await handler.fetch(request);
      log({ event: "request", status: res.status, ms: Date.now() - started, tools_enabled: allowedTools.size, tools_total: ALL_TOOLS.length });
      return res;
    } catch (err) {
      log({ event: "request_error", ms: Date.now() - started, message: String((err as Error)?.message ?? err) });
      return json({ error: "internal error", requestId }, 500);
    }
  },
};

function clampInt(raw: string | undefined, dflt: number, min: number, max: number) {
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
