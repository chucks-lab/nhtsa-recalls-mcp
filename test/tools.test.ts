import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { NhtsaClient, parseNhtsaDate, redact } from "../src/nhtsa.js";
import { ALL_TOOLS, buildServer, parseAllowedTools } from "../src/server.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** fetch stub that serves recorded NHTSA responses by URL substring, and can simulate 429/500. */
function fakeFetch(script: { match: string; body?: string; status?: number; times?: number }[]) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    for (const s of script) {
      if (url.includes(s.match) && (s.times === undefined || s.times > 0)) {
        if (s.times !== undefined) s.times--;
        return new Response(s.body ?? "{}", { status: s.status ?? 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

async function connect(fetchImpl: typeof fetch, allowed?: string) {
  const client = new NhtsaClient({ timeoutMs: 2000, retries: 1, fetchImpl });
  const server = buildServer({ allowedTools: parseAllowedTools(allowed), client, log: () => {}, requestId: "test" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "test-client", version: "0.0.0" });
  await mcp.connect(clientSide);
  return mcp;
}

describe("config helpers", () => {
  it("parseAllowedTools defaults to all tools and drops unknown names", () => {
    expect([...parseAllowedTools(undefined)]).toEqual([...ALL_TOOLS]);
    expect([...parseAllowedTools("get_recalls, decode_vin, bogus")]).toEqual(["get_recalls", "decode_vin"]);
  });
  it("redact masks VINs in log URLs", () => {
    expect(redact("https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/1FTEW1E5XKFA12345?format=json")).toContain("***********A12345");
  });
  it("parseNhtsaDate handles both NHTSA date orders", () => {
    expect(new Date(parseNhtsaDate("21/02/2020", "DMY")).toISOString()).toBe("2020-02-21T00:00:00.000Z");
    expect(new Date(parseNhtsaDate("09/10/2026", "MDY")).toISOString()).toBe("2026-09-10T00:00:00.000Z");
    // wrong-order hint but unambiguous day: flips
    expect(new Date(parseNhtsaDate("21/02/2020", "MDY")).toISOString()).toBe("2020-02-21T00:00:00.000Z");
  });
});

describe("tool registration", () => {
  it("lists only allowlisted tools with readOnly annotations", async () => {
    const mcp = await connect(fakeFetch([]).impl, "get_recalls,decode_vin");
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["decode_vin", "get_recalls"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    await mcp.close();
  });
});

describe("tools against recorded NHTSA responses", () => {
  it("get_recalls sorts newest first and honors limit", async () => {
    const f = fakeFetch([{ match: "recallsByVehicle", body: fixture("recalls_f150_2019.json") }]);
    const mcp = await connect(f.impl);
    const res = await mcp.callTool({ name: "get_recalls", arguments: { make: "Ford", model: "F-150", model_year: 2019, limit: 3 } });
    const sc = res.structuredContent as { count: number; recalls: { campaign_number: string; report_received: string }[] };
    expect(sc.count).toBe(9);
    expect(sc.recalls).toHaveLength(3);
    const dates = sc.recalls.map((r) => parseNhtsaDate(r.report_received, "DMY"));
    expect(dates[0]).toBeGreaterThanOrEqual(dates[1]);
    expect(dates[1]).toBeGreaterThanOrEqual(dates[2]);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toMatch(/9 recall\(s\) for 2019 Ford F-150 \(showing 3\)/);
    expect(f.calls[0]).toContain("make=Ford&model=F-150&modelYear=2019");
    await mcp.close();
  });

  it("get_complaints aggregates components and flags", async () => {
    const f = fakeFetch([{ match: "complaintsByVehicle", body: fixture("complaints_f150_2019.json") }]);
    const mcp = await connect(f.impl);
    const res = await mcp.callTool({ name: "get_complaints", arguments: { make: "Ford", model: "F-150", model_year: 2019, limit: 2, summary_chars: 100 } });
    const sc = res.structuredContent as { total: number; top_components: unknown[]; recent: { summary: string }[] };
    expect(sc.total).toBe(41);
    expect(sc.top_components.length).toBeGreaterThan(0);
    expect(sc.recent).toHaveLength(2);
    for (const r of sc.recent) expect(r.summary.length).toBeLessThanOrEqual(100);
    await mcp.close();
  });

  it("decode_vin extracts the useful fields", async () => {
    const f = fakeFetch([{ match: "DecodeVinValues", body: fixture("vpic_1FTEW1E5XKFA12345.json") }]);
    const mcp = await connect(f.impl);
    const res = await mcp.callTool({ name: "decode_vin", arguments: { vin: "1FTEW1E5XKFA12345" } });
    const sc = res.structuredContent as { make: string; model: string; model_year: string };
    expect(sc.make).toBe("FORD");
    expect(sc.model).toBe("F-150");
    expect(sc.model_year).toBe("2019");
    await mcp.close();
  });

  it("list_models dedupes and sorts", async () => {
    const f = fakeFetch([{ match: "products/vehicle/models", body: fixture("models_ford_2019.json") }]);
    const mcp = await connect(f.impl);
    const res = await mcp.callTool({ name: "list_models", arguments: { make: "Ford", model_year: 2019 } });
    const sc = res.structuredContent as { models: string[] };
    expect(new Set(sc.models).size).toBe(sc.models.length);
    expect(sc.models).toContain("F-150");
    await mcp.close();
  });

  it("get_safety_ratings falls back to the rated-model list when the spelling misses", async () => {
    const f = fakeFetch([
      { match: "/model/F-150", body: fixture("ratings_variants_f150_2019.json") },
      { match: "SafetyRatings/modelyear/2019/make/Ford", body: JSON.stringify({ Count: 2, Results: [{ Model: "F-150 SUPER CREW" }, { Model: "FIESTA" }] }) },
    ]);
    const mcp = await connect(f.impl);
    const res = await mcp.callTool({ name: "get_safety_ratings", arguments: { make: "Ford", model: "F-150", model_year: 2019 } });
    const sc = res.structuredContent as { close_matches: string[] };
    expect(sc.close_matches).toEqual(["F-150 SUPER CREW"]);
    await mcp.close();
  });

  it("retries once on 429 then succeeds", async () => {
    const f = fakeFetch([
      { match: "recallsByVehicle", status: 429, times: 1 },
      { match: "recallsByVehicle", body: fixture("recalls_f150_2019.json") },
    ]);
    const mcp = await connect(f.impl);
    const res = await mcp.callTool({ name: "get_recalls", arguments: { make: "Ford", model: "F-150", model_year: 2019 } });
    expect(res.isError).toBeFalsy();
    expect(f.calls.filter((u) => u.includes("recallsByVehicle"))).toHaveLength(2);
    await mcp.close();
  });

  it("returns an isError result (not a protocol error) when NHTSA keeps failing", async () => {
    const f = fakeFetch([{ match: "recallsByVehicle", status: 503 }]);
    const mcp = await connect(f.impl);
    const res = await mcp.callTool({ name: "get_recalls", arguments: { make: "Ford", model: "F-150", model_year: 2019 } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/HTTP 503/);
    await mcp.close();
  });
});
