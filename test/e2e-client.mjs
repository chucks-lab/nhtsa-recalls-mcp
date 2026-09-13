// End-to-end check against a running server (local `wrangler dev` or the deployed Worker).
// Usage: node test/e2e-client.mjs [http://127.0.0.1:8787/mcp] [bearer-token]
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = new URL(process.argv[2] ?? "http://127.0.0.1:8787/mcp");
const token = process.argv[3];

const health = await fetch(new URL("/health", url.origin));
console.log("health:", health.status, await health.text());

const transport = new StreamableHTTPClientTransport(url, token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined);
const client = new Client({ name: "e2e", version: "0.0.0" });
await client.connect(transport);
console.log("connected; server:", client.getServerVersion?.() ?? "(unknown)");

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const vin = await client.callTool({ name: "decode_vin", arguments: { vin: "5YJ3E1EA7KF317000" } });
console.log("\n[decode_vin]\n" + vin.content[0].text);

const recalls = await client.callTool({ name: "get_recalls", arguments: { make: "Tesla", model: "Model 3", model_year: 2019, limit: 3 } });
console.log("\n[get_recalls]\n" + recalls.content[0].text.slice(0, 900));

const complaints = await client.callTool({ name: "get_complaints", arguments: { make: "Ford", model: "F-150", model_year: 2019, limit: 2, summary_chars: 200 } });
console.log("\n[get_complaints]\n" + complaints.content[0].text.slice(0, 900));

const ratings = await client.callTool({ name: "get_safety_ratings", arguments: { make: "Ford", model: "F-150 SUPER CREW", model_year: 2019 } });
console.log("\n[get_safety_ratings]\n" + ratings.content[0].text.slice(0, 900));

const bad = await client.callTool({ name: "get_recalls", arguments: { make: "Ford", model: "F-150", model_year: 1900 } }).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
console.log("\n[validation]", bad.isError ? `rejected as expected: ${bad.content[0].text.slice(0, 120)}` : "NOT REJECTED");

const failures = [vin, recalls, complaints, ratings].filter((r) => r.isError).length + (bad.isError ? 0 : 1);
await client.close();
if (failures) {
  console.error(`\nE2E FAILED: ${failures} check(s) returned errors`);
  process.exit(1);
}
console.log("\nE2E OK");
