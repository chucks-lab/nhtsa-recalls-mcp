// Thin, defensive client for NHTSA's public JSON APIs.
// Endpoints (all unauthenticated, all read-only):
//   https://api.nhtsa.gov/recalls/recallsByVehicle?make=&model=&modelYear=
//   https://api.nhtsa.gov/recalls/campaignNumber?campaignNumber=
//   https://api.nhtsa.gov/complaints/complaintsByVehicle?make=&model=&modelYear=
//   https://api.nhtsa.gov/SafetyRatings/modelyear/{y}/make/{m}/model/{mo}
//   https://api.nhtsa.gov/SafetyRatings/VehicleId/{id}
//   https://api.nhtsa.gov/products/vehicle/models?modelYear=&make=&issueType=
//   https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{vin}?format=json[&modelyear=]

export interface NhtsaClientOptions {
  timeoutMs: number;
  /** Retries for 429 / 5xx / network errors. One retry with a short backoff is plenty for a demo. */
  retries?: number;
  fetchImpl?: typeof fetch;
  log?: (event: Record<string, unknown>) => void;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly url: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

const API = "https://api.nhtsa.gov";
const VPIC = "https://vpic.nhtsa.dot.gov/api/vehicles";

export class NhtsaClient {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (event: Record<string, unknown>) => void;

  constructor(opts: NhtsaClientOptions) {
    this.timeoutMs = opts.timeoutMs;
    this.retries = opts.retries ?? 1;
    // Wrap the global fetch: storing it as a method and calling `this.fetchImpl(...)` would invoke it with
    // the wrong `this` and throw "Illegal invocation" on Cloudflare Workers.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.log = opts.log ?? (() => {});
  }

  // ---- public API -------------------------------------------------------

  async recallsByVehicle(make: string, model: string, modelYear: number) {
    const url = `${API}/recalls/recallsByVehicle?make=${enc(make)}&model=${enc(model)}&modelYear=${modelYear}`;
    return this.getJson<RecallsResponse>(url);
  }

  async recallByCampaign(campaignNumber: string) {
    const url = `${API}/recalls/campaignNumber?campaignNumber=${enc(campaignNumber)}`;
    return this.getJson<RecallsResponse>(url);
  }

  async complaintsByVehicle(make: string, model: string, modelYear: number) {
    const url = `${API}/complaints/complaintsByVehicle?make=${enc(make)}&model=${enc(model)}&modelYear=${modelYear}`;
    return this.getJson<ComplaintsResponse>(url);
  }

  async safetyRatingVariants(modelYear: number, make: string, model: string) {
    const url = `${API}/SafetyRatings/modelyear/${modelYear}/make/${enc(make)}/model/${enc(model)}`;
    return this.getJson<SafetyVariantsResponse>(url);
  }

  async ratedModels(modelYear: number, make: string) {
    const url = `${API}/SafetyRatings/modelyear/${modelYear}/make/${enc(make)}`;
    return this.getJson<RatedModelsResponse>(url);
  }

  async safetyRatingById(vehicleId: number) {
    const url = `${API}/SafetyRatings/VehicleId/${vehicleId}`;
    return this.getJson<SafetyRatingResponse>(url);
  }

  async models(modelYear: number, make: string, issueType: "r" | "c" = "r") {
    const url = `${API}/products/vehicle/models?modelYear=${modelYear}&make=${enc(make)}&issueType=${issueType}`;
    return this.getJson<ModelsResponse>(url);
  }

  async decodeVin(vin: string, modelYear?: number) {
    const qs = modelYear ? `?format=json&modelyear=${modelYear}` : "?format=json";
    const url = `${VPIC}/DecodeVinValues/${enc(vin)}${qs}`;
    return this.getJson<VpicResponse>(url);
  }

  // ---- internals ---------------------------------------------------------

  private async getJson<T>(url: string): Promise<T> {
    let attempt = 0;
    // attempt 0 plus `retries` more
    for (;;) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json", "user-agent": "nhtsa-recalls-mcp/0.1 (+https://github.com/chucks-lab/nhtsa-recalls-mcp)" },
          signal: controller.signal,
        });
        const ms = Date.now() - started;
        this.log({ event: "upstream", url: redact(url), status: res.status, ms, attempt });

        if (res.status === 429 || res.status >= 500) {
          const retryable = attempt < this.retries;
          if (retryable) {
            attempt++;
            await sleep(backoffMs(attempt, res.headers.get("retry-after")));
            continue;
          }
          throw new UpstreamError(`NHTSA returned HTTP ${res.status}`, res.status, url, false);
        }
        if (!res.ok) {
          // 4xx other than 429: not our fault to retry; surface it.
          const body = await safeText(res);
          throw new UpstreamError(`NHTSA returned HTTP ${res.status}: ${body.slice(0, 200)}`, res.status, url, false);
        }
        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof UpstreamError) throw err;
        const ms = Date.now() - started;
        const aborted = (err as Error)?.name === "AbortError";
        this.log({ event: "upstream_error", url: redact(url), ms, attempt, aborted, message: String((err as Error)?.message ?? err) });
        if (attempt < this.retries) {
          attempt++;
          await sleep(backoffMs(attempt, null));
          continue;
        }
        throw new UpstreamError(aborted ? `NHTSA request timed out after ${this.timeoutMs} ms` : `NHTSA request failed: ${String((err as Error)?.message ?? err)}`, null, url, false);
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

function enc(s: string) {
  return encodeURIComponent(s.trim());
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number, retryAfter: string | null) {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra > 0 && ra <= 10) return ra * 1000;
  return Math.min(250 * 2 ** attempt, 2000);
}

async function safeText(res: Response) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * NHTSA is inconsistent about date formats: the recalls API returns DD/MM/YYYY ("21/02/2020"),
 * the complaints API returns MM/DD/YYYY ("09/10/2026"). Callers pass the order they expect; when the
 * first field cannot be a month we flip the order regardless.
 */
export function parseNhtsaDate(s: string | undefined, order: "DMY" | "MDY"): number {
  if (!s) return 0;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s.trim());
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
  }
  let a = Number(m[1]);
  let b = Number(m[2]);
  const y = Number(m[3]);
  let day: number;
  let month: number;
  if (order === "DMY") {
    day = a;
    month = b;
  } else {
    month = a;
    day = b;
  }
  if (month > 12 && day <= 12) [day, month] = [month, day];
  const t = Date.UTC(y, month - 1, day);
  return Number.isFinite(t) ? t : 0;
}

/** VINs are vehicle identifiers, not personal data, but keep logs tidy: mask all but the last 6 characters. */
export function redact(url: string) {
  return url.replace(/(DecodeVinValues\/)([A-Za-z0-9]{6,})/, (_m, p, vin: string) => `${p}${"*".repeat(Math.max(0, vin.length - 6))}${vin.slice(-6)}`);
}

// ---- upstream response shapes (only the fields we use) -------------------

export interface RecallRecord {
  Manufacturer?: string;
  NHTSACampaignNumber?: string;
  parkIt?: boolean;
  parkOutSide?: boolean;
  overTheAirUpdate?: boolean;
  ReportReceivedDate?: string;
  Component?: string;
  Summary?: string;
  Consequence?: string;
  Remedy?: string;
  Notes?: string;
  ModelYear?: string;
  Make?: string;
  Model?: string;
}
export interface RecallsResponse {
  Count: number;
  Message?: string;
  results: RecallRecord[];
}

export interface ComplaintRecord {
  odiNumber?: number;
  manufacturer?: string;
  crash?: boolean;
  fire?: boolean;
  numberOfInjuries?: number;
  numberOfDeaths?: number;
  dateOfIncident?: string;
  dateComplaintFiled?: string;
  vin?: string;
  components?: string;
  summary?: string;
  products?: { type?: string; productYear?: string; productMake?: string; productModel?: string; manufacturer?: string }[];
}
export interface ComplaintsResponse {
  count: number;
  message?: string;
  results: ComplaintRecord[];
}

export interface SafetyVariant {
  VehicleDescription?: string;
  VehicleId?: number;
}
export interface SafetyVariantsResponse {
  Count: number;
  Message?: string;
  Results: SafetyVariant[];
}

export interface RatedModelsResponse {
  Count: number;
  Message?: string;
  Results: { ModelYear?: number; Make?: string; Model?: string }[];
}

export interface SafetyRatingRecord {
  VehicleId?: number;
  VehicleDescription?: string;
  OverallRating?: string;
  OverallFrontCrashRating?: string;
  FrontCrashDriversideRating?: string;
  FrontCrashPassengersideRating?: string;
  OverallSideCrashRating?: string;
  SideCrashDriversideRating?: string;
  SideCrashPassengersideRating?: string;
  RolloverRating?: string;
  RolloverPossibility?: number;
  SidePoleCrashRating?: string;
  NHTSAElectronicStabilityControl?: string;
  NHTSAForwardCollisionWarning?: string;
  NHTSALaneDepartureWarning?: string;
  ComplaintsCount?: number;
  RecallsCount?: number;
  InvestigationCount?: number;
  ModelYear?: number;
  Make?: string;
  Model?: string;
  VehiclePicture?: string;
}
export interface SafetyRatingResponse {
  Count: number;
  Message?: string;
  Results: SafetyRatingRecord[];
}

export interface ModelsResponse {
  count: number;
  message?: string;
  results: { modelYear?: string; make?: string; model?: string }[];
}

export interface VpicResponse {
  Count: number;
  Message?: string;
  SearchCriteria?: string;
  Results: Record<string, string>[];
}
