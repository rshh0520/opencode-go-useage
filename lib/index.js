/**
 * dsh-opencode-go-usage —— host (node) half.
 *
 * 宿主侧只做一件浏览器做不到的事：带 API Key 去 opencode Go 官方用量接口取数，
 * 并通过同源路由 `GET /opencode-go-usage` 交给页面（浏览器直连会撞 CORS，
 * 且 API Key 不应下发到页面）。
 *
 * 上游契约（已核实）：
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <key>
 *   → 200 {"usage":{
 *          "rolling": {"status":"ok","percent":4,"resetsAt":"2026-08-13T16:27:38.287Z"},
 *          "weekly":  {...}, "monthly": {...}}}
 * 其中 percent 是「已用百分比」(0–100)，响应里没有 used/limit/remaining，
 * 因此剩余量按 100 - percent 计算。401 = 密钥无效；403 = 密钥有效但无 Go 套餐。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** cordis 插件名。 */
export const name = "opencode-go-usage";

/** 依赖宿主 web 服务，才能在页面同源下暴露取数路由。 */
export const inject = ["webServer"];

/**
 * 凭据来源（按优先级）：
 *   1. `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY` 环境变量 —— 进程启动快照，改名需重启；
 *   2. DSH 托管的凭据 seam（`ctx.credentials`，即 `$DSH_HOME/.credentials.yaml`）——
 *      在 DSH 设置页换 Key 写的就是这里，每次取数重新 resolve，无需重启；
 *   3. `OPENCODE_AUTH_CONTENT`（整份 auth.json）；
 *   4. `~/.local/share/opencode/auth.json` 的 `opencode-go` —— opencode 自己登录时写的。
 *
 * credentials 服务故意不写进 `inject`：它由 dsh-base 的 credentials-local 提供，
 * 但不是所有组合都有，写死依赖会让插件在缺服务的组合里根本不 apply。用
 * `ctx.get("credentials")` 惰性取，取不到就自动跳过这一层。
 */

/** 页面轮询的同源路由（不带 /api 前缀，因此不触发连接层的 /api 信任栅栏）。 */
const ROUTE = "/opencode-go-usage";

/** 上游用量接口。 */
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** 缓存有效期：略短于客户端 60s 轮询，避免多标签页放大上游请求。 */
const CACHE_MS = 30 * 1000;

/** 失败时的退避，避免上游故障期间被轮询打爆。 */
const ERROR_CACHE_MS = 20 * 1000;

/** 上游请求超时。 */
const UPSTREAM_TIMEOUT_MS = 15 * 1000;

/**
 * DSH 托管凭据里承载 opencode Go 密钥的引用名。
 * 在 DSH 设置页换 Key 时，写入的是 `$DSH_HOME/.credentials.yaml` 的这个 ref，
 * 按设计不会回写到进程环境，所以必须走 `ctx.credentials` 才能读到新值。
 */
const KEY_REF = "OPENCODE_GO_API_KEY";

/** 轮询类客户端礼貌自我标识。 */
const USER_AGENT = "dsh-opencode-go-usage/1.0";

/** 三个窗口的显示名，顺序固定。 */
const WINDOW_LABELS = [
  ["rolling", "Rolling usage"],
  ["weekly", "Weekly usage"],
  ["monthly", "Monthly usage"],
];

/** 备用字段别名，兼容接口早期曾出现过的扁平结构。 */
const LEGACY_CONTAINERS = ["rollingUsage", "weeklyUsage", "monthlyUsage"];

/**
 * 宽松地把一个值转成有限数字。
 * @param {unknown} value - 原始值。
 * @returns {number|null} 数字，或 null。
 */
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(/[^0-9.eE+-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 把 ISO 时间串或秒级时间戳转成可显示的 ISO 串。
 * @param {unknown} value - resetsAt / resetInSec 原始值。
 * @returns {string|null} ISO-8601 字符串，或 null。
 */
function toIso(value) {
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value.trim());
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const seconds = toNumber(value);
  if (seconds === null) return null;
  // resetInSec 是「距今秒数」；若数值很大则当作绝对秒级时间戳处理。
  const ms = seconds > 1e9 ? seconds * 1000 : Date.now() + seconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * 归一化单个窗口。
 * @param {string} key - 'rolling' | 'weekly' | 'monthly'。
 * @param {string} label - 显示名。
 * @param {unknown} raw - 上游该窗口的原始对象。
 * @returns {{ key: string, label: string, status: string, percent: number|null, remainingPercent: number|null, resetsAt: string|null }} 归一化窗口。
 */
function normalizeWindow(key, label, raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const percent = toNumber(source.percent ?? source.usagePercent ?? source.percentUsed);
  const status = typeof source.status === "string" ? source.status : percent !== null && percent >= 100 ? "rate-limited" : "ok";

  // 官方文档提醒：percent 为 0 时上游的 resetsAt 只是 now+window 的占位值，不是真实重置时间，故丢弃。
  const resetsAt = percent === 0 ? null : toIso(source.resetsAt ?? source.resetInSec ?? source.resetAt);

  const clamped = percent === null ? null : Math.max(0, Math.min(100, percent));
  return {
    key: key,
    label: label,
    status: status,
    percent: clamped,
    remainingPercent: clamped === null ? null : Math.max(0, 100 - clamped),
    resetsAt: resetsAt,
  };
}

/**
 * 从上游响应体里抽取三个窗口。优先当前 `{usage:{...}}` 结构，其次兼容早期扁平结构。
 * @param {unknown} body - 上游 JSON。
 * @returns {Array<ReturnType<typeof normalizeWindow>>} 归一化窗口（可能不足三项）。
 */
function normalizeBody(body) {
  const root = body !== null && typeof body === "object" ? body : {};
  const container =
    root.usage !== null && typeof root.usage === "object" ? root.usage : root;

  const windows = [];
  for (const pair of WINDOW_LABELS) {
    const key = pair[0];
    const label = pair[1];
    const raw = container[key] ?? root[key] ?? root[key + "Usage"];
    if (raw === undefined || raw === null) continue;
    windows.push(normalizeWindow(key, label, raw));
  }

  // 早期扁平结构：{useBalance, rollingUsage:{status,resetInSec,usagePercent}, ...}
  if (windows.length === 0) {
    for (let i = 0; i < LEGACY_CONTAINERS.length; i++) {
      const raw = root[LEGACY_CONTAINERS[i]];
      if (raw === undefined || raw === null) continue;
      windows.push(normalizeWindow(WINDOW_LABELS[i][0], WINDOW_LABELS[i][1], raw));
    }
  }

  return windows;
}

/**
 * 读取 opencode 的凭据文件（auth.json）。
 * @returns {{ key: string, source: string } | null} 凭据及其来源描述。
 */
function readAuthFile() {
  const dataHome = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim() !== ""
    ? process.env.XDG_DATA_HOME.trim()
    : join(homedir(), ".local", "share");
  const file = join(dataHome, "opencode", "auth.json");

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const entry = parsed !== null && typeof parsed === "object" ? parsed["opencode-go"] : undefined;
    if (entry === null || typeof entry !== "object") return null;
    // api 凭据用 key；oauth 凭据用 access。
    const value = typeof entry.key === "string" && entry.key !== "" ? entry.key : entry.access;
    if (typeof value !== "string" || value.trim() === "") return null;
    return { key: value.trim(), source: file };
  } catch {
    return null;
  }
}

/**
 * 解析 OPENCODE_AUTH_CONTENT（整份 auth.json 的 JSON 字符串）。
 * @returns {{ key: string, source: string } | null} 凭据及其来源描述。
 */
function readAuthContentEnv() {
  const raw = process.env.OPENCODE_AUTH_CONTENT;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    const entry = parsed !== null && typeof parsed === "object" ? parsed["opencode-go"] : undefined;
    if (entry === null || typeof entry !== "object") return null;
    const value = typeof entry.key === "string" && entry.key !== "" ? entry.key : entry.access;
    if (typeof value !== "string" || value.trim() === "") return null;
    return { key: value.trim(), source: "OPENCODE_AUTH_CONTENT" };
  } catch {
    return null;
  }
}

/**
 * 从 DSH 的凭据 seam（`ctx.credentials`）解析 Key。
 *
 * 这条来源是「在 DSH 里换 Key」唯一能自动生效的通道：DSH 设置页把新值写进
 * `$DSH_HOME/.credentials.yaml`，托管文档不会 materialize 到进程环境，只有
 * `ctx.credentials.resolve()` 能拿到。每次取数都重新 resolve，因此换 Key 后
 * 下一个轮询周期就会用新值，无需重启。
 *
 * @param {object} ctx - cordis 插件上下文；缺失或没有 credentials 服务时返回 null。
 * @returns {Promise<{ key: string, source: string } | null>} 凭据及其来源描述。
 */
async function readDshCredential(ctx) {
  const credentials = ctx !== null && typeof ctx === "object" && typeof ctx.get === "function"
    ? ctx.get("credentials")
    : null;
  if (credentials === null || credentials === undefined || typeof credentials.resolve !== "function") return null;

  let hit;
  try {
    hit = await credentials.resolve(KEY_REF);
  } catch {
    return null;
  }
  if (hit === null || hit === undefined) return null;

  const value = typeof hit.value === "string" ? hit.value.trim() : "";
  if (value === "") return null;

  const layer = typeof hit.source === "string" && hit.source !== "" ? ` / ${hit.source}` : "";
  return { key: value, source: `${KEY_REF}（DSH 凭据${layer}）` };
}

/**
 * 按优先级解析 API Key：环境变量 → DSH 凭据 → OPENCODE_AUTH_CONTENT → auth.json。
 * @param {object} ctx - cordis 插件上下文（用于访问 credentials 服务）。
 * @returns {Promise<{ key: string, source: string } | null>} 凭据及其来源描述。
 */
async function resolveCredential(ctx) {
  for (const env of ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"]) {
    const value = process.env[env];
    if (typeof value === "string" && value.trim() !== "") {
      return { key: value.trim(), source: env };
    }
  }
  return (await readDshCredential(ctx)) ?? readAuthContentEnv() ?? readAuthFile();
}

/**
 * 请求上游用量接口。
 * @param {string} key - API Key。
 * @returns {Promise<object[]>} 归一化窗口数组。
 */
async function fetchUsage(key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(error instanceof Error && error.name === "AbortError" ? "上游请求超时" : `无法连接上游：${message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error("API Key 无效或已失效（401）");
    if (response.status === 403) throw new Error("该密钥有效，但账号没有 opencode Go 套餐（403）");
    throw new Error(`上游返回 HTTP ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("上游响应不是合法 JSON");
  }

  const windows = normalizeBody(body);
  if (windows.length === 0) throw new Error("上游响应里没有可识别的用量窗口");
  return windows;
}

/** 上一次取数结果（成功或失败），用于 TTL 缓存。 */
let cache = null;

/**
 * 取用量（带 TTL 缓存与并发合并）。
 * @param {object} ctx - cordis 插件上下文（凭据来自 credentials 服务时要靠它）。
 * @returns {Promise<object>} 面向客户端的响应体。
 */
async function readUsage(ctx) {
  const now = Date.now();
  if (cache !== null) {
    if (cache.pending !== null) return cache.pending;
    const ttl = cache.ok ? CACHE_MS : ERROR_CACHE_MS;
    if (now - cache.at < ttl) return cache.body;
  }

  const credential = await resolveCredential(ctx);
  if (credential === null) {
    const body = {
      ok: false,
      error: "未找到 opencode Go API Key：请设置 OPENCODE_GO_API_KEY，或先运行 opencode 完成登录",
      windows: [],
    };
    cache = { at: now, ok: false, body: body, pending: null };
    return body;
  }

  const pending = fetchUsage(credential.key)
    .then((windows) => {
      const body = {
        ok: true,
        windows: windows,
        keySource: credential.source,
        // 供页面比对自己缓存的凭据快照：换 Key 后连面板显示的 Key 也能自动跟进。
        keyMasked: maskKey(credential.key),
        fetchedAt: new Date().toISOString(),
      };
      cache = { at: Date.now(), ok: true, body: body, pending: null };
      return body;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const body = { ok: false, error: message, windows: [] };
      cache = { at: Date.now(), ok: false, body: body, pending: null };
      return body;
    });

  cache = { at: now, ok: false, body: { ok: false, error: "正在获取用量…", windows: [] }, pending: pending };
  return pending;
}

/**
 * 把 API Key 脱敏成 `sk-abc…wxyz` 形式，供默认展示。
 * @param {string} key - 完整密钥。
 * @returns {string} 脱敏文本。
 */
function maskKey(key) {
  if (typeof key !== "string" || key === "") return "";
  if (key.length <= 12) return key.slice(0, 2) + "…";
  return key.slice(0, 6) + "…" + key.slice(-4);
}

/**
 * 读取当前凭据（含明文，仅供本页同源的「查看 Key」使用）。
 * @param {object} ctx - cordis 插件上下文。
 * @returns {Promise<object>} 面向客户端的凭据响应体。
 */
async function readCredential(ctx) {
  const credential = await resolveCredential(ctx);
  if (credential === null) {
    return {
      ok: false,
      error: "未找到 opencode Go API Key：请设置 OPENCODE_GO_API_KEY，或先运行 opencode 完成登录",
    };
  }
  return {
    ok: true,
    key: credential.key,
    masked: maskKey(credential.key),
    source: credential.source,
    length: credential.key.length,
  };
}

/**
 * 写出一个 JSON 响应（HEAD 只发头）。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {object} body - 响应体。
 */
function sendJson(req, res, body) {
  const payload = JSON.stringify(body);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(payload);
}

/**
 * 判断请求是否来自本页同源（原生 webServer 路由不带连接层的信任栅栏，这里自行把关）。
 * 跨站发起的请求即便读不到响应，也不应触发我们的轮询与上游请求。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 是否可信。
 */
function isSameOrigin(req) {
  const headers = req !== null && typeof req === "object" && req.headers ? req.headers : {};
  const site = headers["sec-fetch-site"];
  if (typeof site === "string" && (site === "cross-site" || site === "same-site")) return false;
  const origin = headers.origin;
  const host = headers.host;
  if (typeof origin === "string" && typeof host === "string") {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 安装宿主侧插件：注册同源用量路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        // prefix：一个路由同时承载 `/opencode-go-usage`（用量）与
        // `/opencode-go-usage/key`（凭据），不必占用两个路径。
        kind: "prefix",
        path: ROUTE,
        handler: async (req, res) => {
          if (!isSameOrigin(req)) {
            res.writeHead(403);
            res.end();
            return;
          }
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { allow: "GET, HEAD" });
            res.end();
            return;
          }

          let pathname = ROUTE;
          try {
            pathname = new URL(req.url ?? ROUTE, "http://x").pathname;
          } catch {
            pathname = ROUTE;
          }

          if (pathname === ROUTE) {
            sendJson(req, res, await readUsage(ctx));
            return;
          }
          if (pathname === `${ROUTE}/key`) {
            sendJson(req, res, await readCredential(ctx));
            return;
          }
          res.writeHead(404);
          res.end();
        },
      }),
    "opencode-go-usage: /opencode-go-usage route"
  );
}
