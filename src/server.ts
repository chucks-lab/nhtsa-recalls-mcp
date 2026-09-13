import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { NhtsaClient, UpstreamError, parseNhtsaDate, type ComplaintRecord, type RecallRecord, type SafetyRatingRecord } from "./nhtsa.js";

export const ALL_TOOLS = [
  "decode_vin",
  "list_models",
  "get_recalls",
  "get_recall_by_campaign",
  "get_complaints",
  "get_safety_ratings",
  "get_safety_rating_by_id",
] as const;
export type ToolName = (typeof ALL_TOOLS)[number];

export interface ServerConfig {
  allowedTools: Set<ToolName>;
  client: NhtsaClient;
  log: (event: Record<string, unknown>) => void;
  requestId: string;
}

export function parseAllowedTools(raw: string | undefined): Set<ToolName> {
  if (!raw || !raw.trim()) return new Set(ALL_TOOLS);
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out = new Set<ToolName>();
  for (const w of wanted) if ((ALL_TOOLS as readonly string[]).includes(w)) out.add(w as ToolName);
  return out;
}

const makeSchema = z.string().min(1).max(60).describe("Vehicle make as NHTSA spells it, e.g. 'Ford', 'Tesla', 'Ram'");
const modelSchema = z.string().min(1).max(60).describe("Vehicle model as NHTSA spells it, e.g. 'F-150', 'Model 3'. Use list_models if unsure.");

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export function buildServer(cfg: ServerConfig): McpServer {
  // Built per request on purpose: Cloudflare Workers freeze the clock at module-evaluation time,
  // so `new Date()` at module scope would report 1970 and cap model years at 1972.
  const yearSchema = z.number().int().min(1949).max(new Date().getUTCFullYear() + 2).describe("Model year, e.g. 2019");

  const server = new McpServer(
    { name: "nhtsa-recalls-mcp", version: "0.1.0" },
    {
      instructions:
        "Read-only tools over the US NHTSA public vehicle-safety datasets: VIN decoding, recalls, owner complaints, and NCAP safety ratings. " +
        "Start with decode_vin when you have a VIN, or list_models when unsure how NHTSA spells a model. All data is public and unauthenticated; nothing here writes anywhere.",
    }
  );

  const { client, allowedTools, log, requestId } = cfg;

  const wrap = <A>(name: ToolName, fn: (args: A) => Promise<ToolResult>) => {
    return async (args: A): Promise<ToolResult> => {
      const started = Date.now();
      try {
        const result = await fn(args);
        log({ event: "tool", requestId, tool: name, ms: Date.now() - started, ok: true });
        return result;
      } catch (err) {
        const ms = Date.now() - started;
        if (err instanceof UpstreamError) {
          log({ event: "tool", requestId, tool: name, ms, ok: false, upstreamStatus: err.status, message: err.message });
          return { content: [{ type: "text", text: `Upstream error from NHTSA: ${err.message}. Try again in a moment.` }], isError: true };
        }
        log({ event: "tool", requestId, tool: name, ms, ok: false, message: String((err as Error)?.message ?? err) });
        return { content: [{ type: "text", text: `Tool failed: ${String((err as Error)?.message ?? err)}` }], isError: true };
      }
    };
  };

  if (allowedTools.has("decode_vin")) {
    server.registerTool(
      "decode_vin",
      {
        title: "Decode a VIN",
        description:
          "Decode a 17-character VIN with NHTSA vPIC. Returns make, model, year, trim, body class, engine, fuel type, plant, GVWR class, and any decode warnings. Partial VINs (with * for unknown characters) are accepted by vPIC.",
        inputSchema: z.object({
          vin: z.string().min(5).max(17).describe("Vehicle Identification Number (full 17 chars preferred)"),
          model_year: yearSchema.optional().describe("Optional model year hint; improves decoding for pre-1981 or ambiguous VINs"),
        }),
        annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
      },
      wrap("decode_vin", async ({ vin, model_year }) => {
        const res = await client.decodeVin(vin, model_year);
        const r = res.Results?.[0] ?? {};
        const pick = (k: string) => (r[k] && r[k] !== "Not Applicable" ? r[k] : undefined);
        const decoded = {
          vin: r["VIN"] ?? vin,
          make: pick("Make"),
          model: pick("Model"),
          model_year: pick("ModelYear"),
          trim: pick("Trim"),
          series: pick("Series"),
          body_class: pick("BodyClass"),
          vehicle_type: pick("VehicleType"),
          drive_type: pick("DriveType"),
          engine: [pick("EngineModel"), pick("DisplacementL") ? `${pick("DisplacementL")} L` : undefined, pick("EngineCylinders") ? `${pick("EngineCylinders")} cyl` : undefined, pick("EngineHP") ? `${pick("EngineHP")} hp` : undefined]
            .filter(Boolean)
            .join(", ") || undefined,
          fuel_type: pick("FuelTypePrimary"),
          electrification_level: pick("ElectrificationLevel"),
          battery_kwh: pick("BatteryKWh"),
          transmission: pick("TransmissionStyle"),
          gvwr: pick("GVWR"),
          plant: [pick("PlantCity"), pick("PlantState"), pick("PlantCountry")].filter(Boolean).join(", ") || undefined,
          manufacturer: pick("Manufacturer"),
          error_code: pick("ErrorCode"),
          error_text: pick("ErrorText"),
        };
        const lines = Object.entries(decoded)
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => `${k}: ${v}`);
        return { content: [{ type: "text", text: lines.join("\n") || "vPIC returned no data for that VIN." }], structuredContent: decoded };
      })
    );
  }

  if (allowedTools.has("list_models")) {
    server.registerTool(
      "list_models",
      {
        title: "List models for a make and year",
        description: "List the model names NHTSA uses for a make in a model year (from the recalls or complaints product catalog). Use this to get the exact spelling before calling get_recalls or get_complaints.",
        inputSchema: z.object({
          make: makeSchema,
          model_year: yearSchema,
          dataset: z.enum(["recalls", "complaints"]).default("recalls").describe("Which catalog to read model names from"),
        }),
        annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
      },
      wrap("list_models", async ({ make, model_year, dataset }) => {
        const res = await client.models(model_year, make, dataset === "complaints" ? "c" : "r");
        const models = [...new Set((res.results ?? []).map((m) => m.model).filter((m): m is string => !!m))].sort();
        const text = models.length ? `${models.length} models for ${make} ${model_year} (${dataset}):\n${models.join(", ")}` : `NHTSA lists no ${dataset} models for ${make} ${model_year}. Check the make spelling (e.g. 'Ram' not 'Dodge Ram').`;
        return { content: [{ type: "text", text }], structuredContent: { make, model_year, dataset, models } };
      })
    );
  }

  if (allowedTools.has("get_recalls")) {
    server.registerTool(
      "get_recalls",
      {
        title: "Recalls for a vehicle",
        description: "List NHTSA safety recalls for a make, model and model year: campaign number, date, component, summary, consequence, remedy, and park-it / park-outside flags.",
        inputSchema: z.object({
          make: makeSchema,
          model: modelSchema,
          model_year: yearSchema,
          limit: z.number().int().min(1).max(50).default(25).describe("Maximum recalls to return (newest first)"),
        }),
        annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
      },
      wrap("get_recalls", async ({ make, model, model_year, limit }) => {
        const res = await client.recallsByVehicle(make, model, model_year);
        const all = (res.results ?? []).slice().sort((a, b) => parseNhtsaDate(b.ReportReceivedDate, "DMY") - parseNhtsaDate(a.ReportReceivedDate, "DMY"));
        const recalls = all.slice(0, limit).map(formatRecall);
        const header = `${res.Count ?? all.length} recall(s) for ${model_year} ${make} ${model}${all.length > limit ? ` (showing ${limit})` : ""}`;
        const text = recalls.length ? `${header}\n\n${recalls.map(recallText).join("\n\n")}` : `${header}. No recalls on file for that exact make/model/year spelling; try list_models to confirm the model name.`;
        return { content: [{ type: "text", text }], structuredContent: { make, model, model_year, count: res.Count ?? all.length, recalls } };
      })
    );
  }

  if (allowedTools.has("get_recall_by_campaign")) {
    server.registerTool(
      "get_recall_by_campaign",
      {
        title: "Recall by campaign number",
        description: "Look up one recall by its NHTSA campaign number (e.g. '23V123000'). Returns every make/model/year the campaign covers.",
        inputSchema: z.object({ campaign_number: z.string().min(6).max(12).describe("NHTSA campaign number, e.g. 23V123000") }),
        annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
      },
      wrap("get_recall_by_campaign", async ({ campaign_number }) => {
        const res = await client.recallByCampaign(campaign_number.toUpperCase());
        const recalls = (res.results ?? []).map(formatRecall);
        const text = recalls.length ? `${recalls.length} record(s) for campaign ${campaign_number.toUpperCase()}\n\n${recalls.map(recallText).join("\n\n")}` : `No recall found for campaign ${campaign_number}.`;
        return { content: [{ type: "text", text }], structuredContent: { campaign_number: campaign_number.toUpperCase(), recalls } };
      })
    );
  }

  if (allowedTools.has("get_complaints")) {
    server.registerTool(
      "get_complaints",
      {
        title: "Owner complaints for a vehicle",
        description:
          "Owner complaints filed with NHTSA for a make, model and model year. Returns the total count, a breakdown by component, and the most recent complaints (crash/fire/injury flags, component, summary). Use component_filter to narrow (e.g. 'ELECTRICAL SYSTEM', 'POWER TRAIN').",
        inputSchema: z.object({
          make: makeSchema,
          model: modelSchema,
          model_year: yearSchema,
          limit: z.number().int().min(1).max(50).default(10).describe("How many individual complaints to include (newest first)"),
          component_filter: z.string().max(80).optional().describe("Case-insensitive substring match on the component field"),
          summary_chars: z.number().int().min(80).max(2000).default(400).describe("Truncate each complaint summary to this many characters"),
        }),
        annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
      },
      wrap("get_complaints", async ({ make, model, model_year, limit, component_filter, summary_chars }) => {
        const res = await client.complaintsByVehicle(make, model, model_year);
        let all = res.results ?? [];
        const total = res.count ?? all.length;
        if (component_filter) {
          const f = component_filter.toLowerCase();
          all = all.filter((c) => (c.components ?? "").toLowerCase().includes(f));
        }
        const byComponent: Record<string, number> = {};
        for (const c of all) {
          for (const comp of (c.components ?? "UNKNOWN").split(",").map((s) => s.trim()).filter(Boolean)) byComponent[comp] = (byComponent[comp] ?? 0) + 1;
        }
        const topComponents = Object.entries(byComponent)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);
        const crashes = all.filter((c) => c.crash).length;
        const fires = all.filter((c) => c.fire).length;
        const injuries = all.reduce((n, c) => n + (c.numberOfInjuries ?? 0), 0);
        const deaths = all.reduce((n, c) => n + (c.numberOfDeaths ?? 0), 0);
        const recent = all
          .slice()
          .sort((a, b) => parseNhtsaDate(b.dateComplaintFiled, "MDY") - parseNhtsaDate(a.dateComplaintFiled, "MDY"))
          .slice(0, limit)
          .map((c) => formatComplaint(c, summary_chars));
        const headline = `${total} complaint(s) on file for ${model_year} ${make} ${model}${component_filter ? `; ${all.length} match component '${component_filter}'` : ""}. Crashes: ${crashes}, fires: ${fires}, injuries: ${injuries}, deaths: ${deaths}.`;
        const compText = topComponents.length ? `Top components:\n${topComponents.map(([k, v]) => `  ${k}: ${v}`).join("\n")}` : "";
        const recentText = recent.length ? `Most recent ${recent.length}:\n\n${recent.map(complaintText).join("\n\n")}` : "";
        return {
          content: [{ type: "text", text: [headline, compText, recentText].filter(Boolean).join("\n\n") }],
          structuredContent: { make, model, model_year, total, matched: all.length, crashes, fires, injuries, deaths, top_components: topComponents.map(([component, count]) => ({ component, count })), recent },
        };
      })
    );
  }

  if (allowedTools.has("get_safety_ratings")) {
    server.registerTool(
      "get_safety_ratings",
      {
        title: "NCAP safety ratings for a vehicle",
        description:
          "NHTSA 5-Star (NCAP) safety ratings for a model year, make and model. If NHTSA rated several variants (e.g. 2WD vs 4WD, cab styles) the variants are listed with VehicleIds; when there is exactly one, its full ratings are returned. Use get_safety_rating_by_id for a specific variant.",
        inputSchema: z.object({ make: makeSchema, model: modelSchema, model_year: yearSchema }),
        annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
      },
      wrap("get_safety_ratings", async ({ make, model, model_year }) => {
        const variants = await client.safetyRatingVariants(model_year, make, model);
        const list = (variants.Results ?? []).filter((v) => v.VehicleId);
        if (list.length === 0) {
          // The ratings dataset spells models its own way ("F-150 SUPER CREW", not "F-150").
          // Fall back to the make's rated-model list and suggest close matches.
          const rated = await client.ratedModels(model_year, make);
          const names = [...new Set((rated.Results ?? []).map((r) => r.Model).filter((m): m is string => !!m))];
          const needle = model.toLowerCase().replace(/[^a-z0-9]/g, "");
          const close = names.filter((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "").includes(needle));
          const suggestions = close.length ? close : names;
          const text = names.length
            ? `NHTSA has no NCAP entry spelled '${model}' for ${model_year} ${make}. Rated ${make} models that year${close.length ? " matching your query" : ""}: ${suggestions.join("; ")}. Call get_safety_ratings again with one of those names.`
            : `NHTSA has no NCAP ratings for any ${model_year} ${make} model. Not every vehicle is tested.`;
          return { content: [{ type: "text", text }], structuredContent: { make, model, model_year, variants: [], rated_models: names, close_matches: close } };
        }
        if (list.length === 1) {
          const rating = await client.safetyRatingById(list[0].VehicleId!);
          const r = rating.Results?.[0];
          const formatted = r ? formatRating(r) : undefined;
          return {
            content: [{ type: "text", text: formatted ? ratingText(formatted) : "Rating record was empty." }],
            structuredContent: { make, model, model_year, variants: list, rating: formatted },
          };
        }
        const text = `${list.length} rated variants for ${model_year} ${make} ${model}. Call get_safety_rating_by_id with one VehicleId:\n${list.map((v) => `  ${v.VehicleId}: ${v.VehicleDescription}`).join("\n")}`;
        return { content: [{ type: "text", text }], structuredContent: { make, model, model_year, variants: list } };
      })
    );
  }

  if (allowedTools.has("get_safety_rating_by_id")) {
    server.registerTool(
      "get_safety_rating_by_id",
      {
        title: "NCAP safety rating by VehicleId",
        description: "Full NHTSA 5-Star ratings for one rated vehicle variant, by the VehicleId returned from get_safety_ratings.",
        inputSchema: z.object({ vehicle_id: z.number().int().positive().describe("NHTSA VehicleId from get_safety_ratings") }),
        annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
      },
      wrap("get_safety_rating_by_id", async ({ vehicle_id }) => {
        const rating = await client.safetyRatingById(vehicle_id);
        const r = rating.Results?.[0];
        if (!r) return { content: [{ type: "text", text: `No rating found for VehicleId ${vehicle_id}.` }], structuredContent: { vehicle_id } };
        const formatted = formatRating(r);
        return { content: [{ type: "text", text: ratingText(formatted) }], structuredContent: { vehicle_id, rating: formatted } };
      })
    );
  }

  return server;
}

// ---- formatting helpers ----------------------------------------------------

function formatRecall(r: RecallRecord) {
  return {
    campaign_number: r.NHTSACampaignNumber,
    report_received: r.ReportReceivedDate,
    manufacturer: r.Manufacturer,
    vehicle: [r.ModelYear, r.Make, r.Model].filter(Boolean).join(" ") || undefined,
    component: r.Component,
    summary: r.Summary,
    consequence: r.Consequence,
    remedy: r.Remedy,
    park_it: r.parkIt ?? false,
    park_outside: r.parkOutSide ?? false,
    over_the_air_update: r.overTheAirUpdate ?? false,
    notes: r.Notes,
  };
}

function recallText(r: ReturnType<typeof formatRecall>) {
  const flags = [r.park_it ? "PARK IT" : null, r.park_outside ? "PARK OUTSIDE" : null, r.over_the_air_update ? "OTA update" : null].filter(Boolean).join(", ");
  return [
    `${r.campaign_number ?? "?"} | ${r.report_received ?? "?"} | ${r.component ?? "?"}${flags ? ` | ${flags}` : ""}${r.vehicle ? ` | ${r.vehicle}` : ""}`,
    r.summary ? `Summary: ${r.summary}` : null,
    r.consequence ? `Consequence: ${r.consequence}` : null,
    r.remedy ? `Remedy: ${r.remedy}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatComplaint(c: ComplaintRecord, summaryChars: number) {
  const s = (c.summary ?? "").replace(/\s+/g, " ").trim();
  return {
    odi_number: c.odiNumber,
    filed: c.dateComplaintFiled,
    incident: c.dateOfIncident,
    components: c.components,
    crash: !!c.crash,
    fire: !!c.fire,
    injuries: c.numberOfInjuries ?? 0,
    deaths: c.numberOfDeaths ?? 0,
    summary: s.length > summaryChars ? `${s.slice(0, summaryChars - 3)}...` : s,
  };
}

function complaintText(c: ReturnType<typeof formatComplaint>) {
  const flags = [c.crash ? "crash" : null, c.fire ? "fire" : null, c.injuries ? `${c.injuries} injured` : null, c.deaths ? `${c.deaths} deaths` : null].filter(Boolean).join(", ");
  return `ODI ${c.odi_number ?? "?"} | filed ${c.filed ?? "?"} | ${c.components ?? "?"}${flags ? ` | ${flags}` : ""}\n${c.summary}`;
}

function formatRating(r: SafetyRatingRecord) {
  return {
    vehicle_id: r.VehicleId,
    description: r.VehicleDescription,
    overall: r.OverallRating,
    frontal_overall: r.OverallFrontCrashRating,
    frontal_driver: r.FrontCrashDriversideRating,
    frontal_passenger: r.FrontCrashPassengersideRating,
    side_overall: r.OverallSideCrashRating,
    side_driver: r.SideCrashDriversideRating,
    side_passenger: r.SideCrashPassengersideRating,
    side_pole: r.SidePoleCrashRating,
    rollover: r.RolloverRating,
    rollover_possibility: r.RolloverPossibility,
    esc: r.NHTSAElectronicStabilityControl,
    forward_collision_warning: r.NHTSAForwardCollisionWarning,
    lane_departure_warning: r.NHTSALaneDepartureWarning,
    complaints_count: r.ComplaintsCount,
    recalls_count: r.RecallsCount,
    investigations_count: r.InvestigationCount,
  };
}

function ratingText(r: ReturnType<typeof formatRating>) {
  const star = (v?: string) => (v && v !== "Not Rated" ? `${v}/5` : "not rated");
  return [
    `${r.description ?? "Vehicle"} (VehicleId ${r.vehicle_id})`,
    `Overall: ${star(r.overall)} | Frontal: ${star(r.frontal_overall)} (driver ${star(r.frontal_driver)}, passenger ${star(r.frontal_passenger)})`,
    `Side: ${star(r.side_overall)} (driver ${star(r.side_driver)}, passenger ${star(r.side_passenger)}, pole ${star(r.side_pole)}) | Rollover: ${star(r.rollover)}${r.rollover_possibility != null ? ` (${(Number(r.rollover_possibility) * 100).toFixed(1)}% risk)` : ""}`,
    `Tech: ESC ${r.esc ?? "?"}, forward collision warning ${r.forward_collision_warning ?? "?"}, lane departure warning ${r.lane_departure_warning ?? "?"}`,
    `On file: ${r.recalls_count ?? "?"} recalls, ${r.complaints_count ?? "?"} complaints, ${r.investigations_count ?? "?"} investigations`,
  ].join("\n");
}
