import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/core/context-engine.ts
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
var _sdkLoaded = false;
var _delegateCompactionToRuntime;
var _buildMemorySystemPromptAddition;
async function ensureSdkLoaded() {
  if (_sdkLoaded)
    return;
  _sdkLoaded = true;
  try {
    const sdk = await import("openclaw/plugin-sdk/core");
    _delegateCompactionToRuntime = sdk.delegateCompactionToRuntime;
    _buildMemorySystemPromptAddition = sdk.buildMemorySystemPromptAddition;
  } catch {
    _delegateCompactionToRuntime = async () => ({ ok: true, compacted: false, reason: "no-runtime" });
    _buildMemorySystemPromptAddition = () => {
      return;
    };
  }
}
var ENGINE_ID = "gbrain-context";
var ENGINE_NAME = "GBrain Context Engine";
var ENGINE_API_VERSION = "0.1.0";
function loadJsonFile(filePath) {
  try {
    if (!existsSync(filePath))
      return null;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
function sanitizeForPrompt(s, maxLen = 100) {
  return s.replace(/[\n\r\t\x00-\x1F\x7F]/g, " ").slice(0, maxLen).trim();
}
var AIRPORT_TZ = {
  SFO: "US/Pacific",
  LAX: "US/Pacific",
  SJC: "US/Pacific",
  SEA: "US/Pacific",
  PDX: "US/Pacific",
  JFK: "US/Eastern",
  LGA: "US/Eastern",
  EWR: "US/Eastern",
  BOS: "US/Eastern",
  DCA: "US/Eastern",
  IAD: "US/Eastern",
  MIA: "US/Eastern",
  ATL: "US/Eastern",
  ORD: "US/Central",
  DFW: "US/Central",
  IAH: "US/Central",
  AUS: "US/Central",
  DEN: "US/Mountain",
  PHX: "US/Arizona",
  HNL: "Pacific/Honolulu",
  YYZ: "America/Toronto",
  YVR: "America/Vancouver",
  YUL: "America/Montreal",
  NRT: "Asia/Tokyo",
  HND: "Asia/Tokyo",
  ICN: "Asia/Seoul",
  SIN: "Asia/Singapore",
  HKG: "Asia/Hong_Kong",
  TPE: "Asia/Taipei",
  LHR: "Europe/London",
  CDG: "Europe/Paris",
  FCO: "Europe/Rome",
  LIS: "Europe/Lisbon",
  BCN: "Europe/Madrid"
};
var DEFAULT_TZ = "US/Pacific";
var DEFAULT_HOME = "San Francisco";
var UNKNOWN_TZ = "UNKNOWN";
function getTimeInTz(tz) {
  const now = new Date;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "00";
  const localH = parseInt(get("hour"));
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
    hour: "2-digit"
  }).formatToParts(now);
  const tzName = tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = tzName.match(/^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::?(?<minutes>\d{2}))?)?$/);
  const sign = m?.groups?.sign ?? "+";
  const hours = m?.groups?.hours ? Number(m.groups.hours) : 0;
  const minutes = m?.groups?.minutes ? Number(m.groups.minutes) : 0;
  const offsetStr = `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  const iso = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offsetStr}`;
  const dayOfWeek = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  return { iso, dayOfWeek, hour: localH };
}
function resolveLocation(hb, flights) {
  if (hb?.currentLocation?.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: hb.currentLocation.timezone }).format(new Date);
      return {
        city: sanitizeForPrompt(hb.currentLocation.city ?? DEFAULT_HOME, 80),
        tz: hb.currentLocation.timezone,
        source: sanitizeForPrompt(hb.currentLocation.source ?? "heartbeat", 80)
      };
    } catch {}
  }
  const active = flights?.flights?.find((f) => f.status === "active");
  if (active?.destination) {
    const destUpper = active.destination.toUpperCase();
    const knownTz = AIRPORT_TZ[destUpper];
    if (knownTz) {
      const flightNumber = sanitizeForPrompt(active.flightNumber ?? "unknown", 40);
      return { city: sanitizeForPrompt(active.destination, 40), tz: knownTz, source: `flight:${flightNumber}` };
    }
    return {
      city: sanitizeForPrompt(hb?.currentLocation?.city ?? active.destination, 80),
      tz: UNKNOWN_TZ,
      source: `flight:${sanitizeForPrompt(active.flightNumber ?? "unknown", 40)}:tz-unknown:${sanitizeForPrompt(destUpper, 40)}`
    };
  }
  return { city: DEFAULT_HOME, tz: DEFAULT_TZ, source: "default" };
}
function parseEventTime(timeStr) {
  if (!timeStr)
    return null;
  const d = new Date(timeStr);
  return isNaN(d.getTime()) ? null : d;
}
function resolveActivity(cache, nowMs) {
  if (!cache?.events?.length) {
    return { currentEvent: null, nextEvents: [], calendarStale: true };
  }
  const parsedLastUpdated = cache.lastUpdated ? new Date(cache.lastUpdated).getTime() : 0;
  const lastUpdated = Number.isNaN(parsedLastUpdated) ? 0 : parsedLastUpdated;
  const calendarStale = nowMs - lastUpdated > 21600000;
  const LOOKAHEAD_MS = 14400000;
  let currentEvent = null;
  const nextEvents = [];
  for (const evt of cache.events) {
    if (evt.start && !evt.start.includes("T"))
      continue;
    if (!evt.summary)
      continue;
    const lower = evt.summary.toLowerCase();
    if (lower === "home" || lower === "ooo" || lower.startsWith("out of office"))
      continue;
    const startMs = parseEventTime(evt.start)?.getTime();
    const endMs = parseEventTime(evt.end)?.getTime();
    if (!startMs)
      continue;
    if (startMs <= nowMs && endMs && endMs > nowMs) {
      if (!currentEvent)
        currentEvent = evt;
      continue;
    }
    if (startMs > nowMs && startMs <= nowMs + LOOKAHEAD_MS) {
      nextEvents.push(evt);
    }
  }
  nextEvents.sort((a, b) => {
    const aMs = parseEventTime(a.start)?.getTime() ?? 0;
    const bMs = parseEventTime(b.start)?.getTime() ?? 0;
    return aMs - bMs;
  });
  return { currentEvent, nextEvents: nextEvents.slice(0, 3), calendarStale };
}
var MAX_TASKS_MD_BYTES = 1e6;
function resolveTodayTasks(workspaceDir) {
  try {
    const path = join(workspaceDir, "ops", "tasks.md");
    if (statSync(path).size > MAX_TASKS_MD_BYTES)
      return [];
    const raw = readFileSync(path, "utf8");
    const todayMatch = raw.match(/## Today[\s\S]*?(?=\n## |$)/);
    if (!todayMatch)
      return [];
    const lines = todayMatch[0].split(`
`);
    const open = [];
    for (const line of lines) {
      const m = line.match(/^\s*-\s*\[ \]\s*\*\*(.+?)\*\*/);
      if (m)
        open.push(sanitizeForPrompt(m[1].trim()));
    }
    return open.slice(0, 5);
  } catch {
    return [];
  }
}
function generateLiveContext(workspaceDir) {
  const hb = loadJsonFile(join(workspaceDir, "memory", "heartbeat-state.json"));
  const flights = loadJsonFile(join(workspaceDir, "memory", "upcoming-flights.json"));
  const calendarCache = loadJsonFile(join(workspaceDir, "memory", "calendar-cache.json"));
  const location = resolveLocation(hb, flights);
  const nowMs = Date.now();
  const tzKnown = location.tz !== UNKNOWN_TZ;
  const time = tzKnown ? getTimeInTz(location.tz) : null;
  const userAwake = hb?.garryAwake ?? true;
  const wallClockQuietHours = time ? time.hour >= 23 || time.hour < 8 : false;
  const quietHoursActive = !userAwake && wallClockQuietHours;
  let homeTime = null;
  if (location.tz !== DEFAULT_TZ && location.tz !== "US/Pacific" && location.tz !== "America/Los_Angeles") {
    const ptFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      weekday: "short"
    });
    homeTime = ptFmt.format(new Date) + " PT";
  }
  const activeFlight = flights?.flights?.find((f) => f.status === "active");
  const activeTravel = activeFlight ? `${sanitizeForPrompt(activeFlight.flightNumber ?? "unknown", 40)}: ${sanitizeForPrompt(activeFlight.origin ?? "unknown", 40)}→${sanitizeForPrompt(activeFlight.destination ?? "unknown", 40)}` : null;
  const { currentEvent, nextEvents, calendarStale } = resolveActivity(calendarCache, nowMs);
  const todayTasks = resolveTodayTasks(workspaceDir);
  return {
    now: time?.iso ?? null,
    timezone: location.tz,
    dayOfWeek: time?.dayOfWeek ?? null,
    homeTime,
    location,
    userAwake,
    wallClockQuietHours,
    quietHoursActive,
    activeTravel,
    currentEvent,
    nextEvents,
    todayTasks,
    calendarStale
  };
}
function formatEventShort(evt, tz) {
  const name = sanitizeForPrompt(evt.summary ?? "Untitled");
  let time = "";
  if (evt.start?.includes("T")) {
    try {
      const d = new Date(evt.start);
      time = d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
    } catch {}
  }
  const attendeeStr = evt.attendees?.length ? ` (with ${evt.attendees.slice(0, 3).map((a) => sanitizeForPrompt(a, 50)).join(", ")}${evt.attendees.length > 3 ? ` +${evt.attendees.length - 3}` : ""})` : "";
  return time ? `${time} — ${name}${attendeeStr}` : `${name}${attendeeStr}`;
}
function formatContextBlock(ctx) {
  const lines = [
    `## Live Context (deterministic, injected by gbrain-context engine)`
  ];
  if (ctx.now && ctx.dayOfWeek && ctx.timezone !== UNKNOWN_TZ) {
    lines.push(`- **Time:** ${ctx.now} (${ctx.timezone})`);
    lines.push(`- **Day:** ${ctx.dayOfWeek}`);
  } else {
    lines.push(`- **Timezone:** unknown (${sanitizeForPrompt(ctx.location.source, 80)})`);
    lines.push(`- ⚠️ Local time NOT computed — verify timezone before time-sensitive actions`);
  }
  lines.push(`- **Location:** ${sanitizeForPrompt(ctx.location.city, 80)} (source: ${sanitizeForPrompt(ctx.location.source, 80)})`);
  if (ctx.homeTime) {
    lines.push(`- **Home (SF):** ${ctx.homeTime}`);
  }
  if (ctx.activeTravel) {
    lines.push(`- **Active travel:** ${sanitizeForPrompt(ctx.activeTravel, 140)}`);
  }
  if (!ctx.userAwake) {
    lines.push(`- **User awake:** no (quiet hours ${ctx.quietHoursActive ? "active" : "paused"})`);
  }
  if (ctx.currentEvent) {
    lines.push(`- **Right now:** ${formatEventShort(ctx.currentEvent, ctx.timezone)}`);
  }
  if (ctx.nextEvents.length > 0) {
    lines.push(`- **Coming up:**`);
    for (const evt of ctx.nextEvents) {
      lines.push(`  - ${formatEventShort(evt, ctx.timezone)}`);
    }
  }
  if (ctx.todayTasks.length > 0) {
    lines.push(`- **Open tasks:** ${ctx.todayTasks.join(" · ")}`);
  }
  if (ctx.calendarStale) {
    lines.push(`- ⚠️ Calendar cache >6h old — verify events via ClawVisor if time-sensitive`);
  }
  lines.push("");
  lines.push("> This block is computed on every turn. Trust it over compaction summaries for time/location/activity.");
  return lines.join(`
`);
}
function createGBrainContextEngine(ctx) {
  const workspaceDir = ctx.workspaceDir ?? process.cwd();
  const engine = {
    info: {
      id: ENGINE_ID,
      name: ENGINE_NAME,
      version: ENGINE_API_VERSION,
      ownsCompaction: false
    },
    async ingest({ message }) {
      return { ingested: true };
    },
    async assemble({ messages, tokenBudget, availableTools, citationsMode }) {
      await ensureSdkLoaded();
      const liveCtx = generateLiveContext(workspaceDir);
      const contextBlock = formatContextBlock(liveCtx);
      const memoryAddition = _buildMemorySystemPromptAddition?.({
        availableTools: availableTools ?? new Set,
        citationsMode
      });
      const parts = [contextBlock];
      if (memoryAddition)
        parts.push(memoryAddition);
      return {
        messages,
        estimatedTokens: messages.reduce((sum, m) => {
          const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          return sum + Math.ceil(text.length / 4);
        }, 0),
        systemPromptAddition: parts.join(`

`)
      };
    },
    async compact(params) {
      await ensureSdkLoaded();
      return _delegateCompactionToRuntime?.(params) ?? { ok: true, compacted: false, reason: "no-runtime" };
    }
  };
  return engine;
}

// src/openclaw-context-engine.ts
var entry = {
  id: "gbrain",
  name: "GBrain Context Engine",
  description: "Deterministic temporal/spatial context injection on every turn",
  register(api) {
    api.registerContextEngine(ENGINE_ID, (ctx) => createGBrainContextEngine({
      workspaceDir: ctx.workspaceDir
    }));
  }
};
var openclaw_context_engine_default = entry;
export {
  openclaw_context_engine_default as default
};
