/**
 * dsh-opencode-go-usage 行为验证（client + host 两半）。
 *
 * 运行：node verify.cjs
 * 只用 Node 内置模块 fs / path / vm，无任何第三方依赖，也无需 npm install。
 *
 * client 半（lib/client.js）：用 vm 沙箱模拟浏览器环境
 *   （window.__ModuleLoader__、setInterval/clearInterval/setTimeout/clearTimeout、
 *    可编程的 window.fetch、极简 React stub），验证挂载 / 取数 / 渲染 / 轮询 / 卸载清理。
 * host 半（lib/index.js）：用带 cache-busting query 的动态 import 反复加载 ESM 宿主半，
 *   验证路由注册、上游请求形态、归一化、错误映射、TTL 缓存与 405。
 *
 * ⚠ 渲染文本的两点说明（脚本按代码真实行为断言）：
 *   1) 主行形如 "Rolling usage 4%"：只有标签 + 已用百分比，不含 "used" / "left" 字样。
 *   2) 分隔符是一个独立的 span（文本 "|"），其后的字符串子节点才是 " "，
 *      因此逐字拼接的 DOM 文本是 "…4%| Weekly usage…"（竖线**前**没有空格）；
 *      而 .sep 的 margin: 0 10px 在视觉上形成间隔。故两个都断言：
 *        - flattenText        → 真实 DOM 文本（竖线前无空格）
 *        - flattenVisibleText → 把 .sep 的 10px 左边距建模为一个空格的"视觉文本"
 *   3) 宿主半的"旧扁平结构"其实是被 normalizeBody 第一个循环里的 root[key + "Usage"]
 *      兜底命中的，LEGACY_CONTAINERS 回退循环属于死代码：对外行为一致
 *      （3 个窗口、percent 取 usagePercent、remainingPercent = 100 - percent）。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const PLUGIN_DIR = __dirname;
const CLIENT_ENTRY = path.join(PLUGIN_DIR, "lib", "client.js");
const HOST_ENTRY = path.join(PLUGIN_DIR, "lib", "index.js");
const CLIENT_BUNDLE = fs.readFileSync(CLIENT_ENTRY, "utf8");

const UPSTREAM_URL = "https://opencode.ai/zen/go/v1/usage";
const ROUTE_PATH = "/opencode-go-usage";
/** 假凭据：用于验证「查看 Key / 复制」链路。 */
const SECRET_KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
/** host 的脱敏规则：前 6 + … + 后 4。 */
const MASKED_KEY = SECRET_KEY.slice(0, 6) + "\u2026" + SECRET_KEY.slice(-4);

// ===== 用例框架 =====
let total = 0;
let passed = 0;
let failed = 0;

async function runCase(name, fn) {
  total += 1;
  try {
    await fn();
    passed += 1;
    console.log("PASS  " + name);
  } catch (error) {
    failed += 1;
    process.exitCode = 1;
    const message = error && error.message ? error.message : String(error);
    // 打印堆栈：断言失败是本脚本自身的 bug 时，message 不足以定位。
    const stack = error && error.stack ? error.stack : "";
    console.error("FAIL  " + name + ": " + message + (stack ? "\n      " + stack.split("\n").slice(1, 4).join("\n      ") : ""));
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "function") return "[function]";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function deepEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (!deepEqual(left[i], right[i])) return false;
    }
    return true;
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (let i = 0; i < leftKeys.length; i += 1) {
      const key = leftKeys[i];
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
      if (!deepEqual(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
}

function checkStyleValue(style, key, expected, label) {
  check(style !== undefined && style !== null, label + "：缺少 style 对象");
  check(
    style[key] === expected,
    label + " 的 " + key + " 应为 " + describeValue(expected) + "，实际 " + describeValue(style[key])
  );
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// ===== 期望值 =====
/** 三个窗口的标签与百分比徽章文本（与 lib/client.js 的渲染逐字对应）。 */
const WINDOW_LABELS = ["Rolling usage", "Weekly usage", "Monthly usage"];
const WINDOW_PERCENT_TEXTS = ["4%", "3%", "1%"];
/** 重置倒计时形如 "Resets in 3h 17m" / "Resets in 4d 20h" / "Resets in 42m"。 */
const RESET_PATTERN = /^Resets in \d+(d \d+h|h \d+m|m)$/;
/** 三窗口倒计时的量级前缀（分钟取整可能 ±1，故只断言前缀）。 */
const RESET_PREFIXES = ["Resets in 3h", "Resets in 4d", "Resets in 12d"];

// ===== 假数据 =====
/** 相对「现在」的未来 ISO 时间：倒计时才有可验证的含义。 */
function futureIso(ms) {
  return new Date(Date.now() + ms).toISOString();
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 三窗口假数据，重置时间分别落在 3h17m / 4d20h / 12d3h 之后（与参考图同量级）。 */
const OK_WINDOWS = [
  {
    key: "rolling",
    label: "Rolling usage",
    status: "ok",
    percent: 4,
    remainingPercent: 96,
    resetsAt: futureIso(3 * HOUR + 17 * MINUTE),
  },
  {
    key: "weekly",
    label: "Weekly usage",
    status: "ok",
    percent: 3,
    remainingPercent: 97,
    resetsAt: futureIso(4 * DAY + 20 * HOUR),
  },
  {
    key: "monthly",
    label: "Monthly usage",
    status: "ok",
    percent: 1,
    remainingPercent: 99,
    resetsAt: futureIso(12 * DAY + 3 * HOUR),
  },
];

function cloneWindows() {
  return OK_WINDOWS.map((window_) => Object.assign({}, window_));
}

/** 造一个 Response-like 假对象（client 只用 ok / status / json()）。 */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    body: body,
    json: function json() {
      return Promise.resolve(body);
    },
  };
}

// ===== 极简 React stub =====
/**
 * 只实现 client bundle 用到的三个 API：
 *   createElement(type, props, ...children) → { type, props, children }（扁平化 children）
 *   useSyncExternalStore(subscribe, getSnapshot) → 真订阅：把 onStoreChange 交给插件，
 *     标记"需要重渲染"，返回 getSnapshot() 的当前值
 *   useEffect(fn, deps) → 记录 effect 及其 cleanup，由测试手动触发，模拟 commit 后执行
 */
function createReactStub() {
  const stack = [];

  function current() {
    if (stack.length === 0) throw new Error("React hook 在组件渲染之外被调用");
    return stack[stack.length - 1];
  }

  function createElement(type, props) {
    const children = [];
    const push = (value) => {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) push(value[i]);
        return;
      }
      if (value === null || value === undefined || typeof value === "boolean") return;
      children.push(value);
    };
    for (let i = 2; i < arguments.length; i += 1) push(arguments[i]);
    return { type: type, props: props || {}, children: children };
  }

  function useSyncExternalStore(subscribe, getSnapshot) {
    const record = current();
    // 重渲染会重新订阅：先退订上一次，避免监听器堆积（React 在 subscribe 变化时也这么做）。
    if (typeof record.unsubscribe === "function") {
      record.unsubscribe();
      record.unsubscribe = null;
    }
    record.subscribeCalls += 1;
    record.unsubscribe = subscribe(function onStoreChange() {
      record.notifications += 1;
      record.pendingRender = true;
    });
    return getSnapshot();
  }

  function useEffect(fn, deps) {
    current().effects.push({ fn: fn, deps: deps });
  }

  function createRoot(component) {
    const record = {
      component: component,
      props: {},
      tree: undefined,
      effects: [],
      cleanups: [],
      unsubscribe: null,
      notifications: 0,
      pendingRender: false,
      renders: 0,
      subscribeCalls: 0,
    };
    record.render = function render() {
      stack.push(record);
      record.effects = [];
      try {
        record.tree = record.component(record.props);
      } finally {
        stack.pop();
      }
      record.renders += 1;
      record.pendingRender = false;
      return record.tree;
    };
    return record;
  }

  return {
    React: {
      createElement: createElement,
      useSyncExternalStore: useSyncExternalStore,
      useEffect: useEffect,
    },
    __createRoot: createRoot,
  };
}

// ===== 渲染树辅助 =====
function isElement(node) {
  return (
    !!node &&
    typeof node === "object" &&
    !Array.isArray(node) &&
    typeof node.type === "string"
  );
}

/** 逐字拼接渲染树文本（等价于 DOM textContent）。 */
function flattenText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isElement(node)) return node.children.map(flattenText).join("");
  return "";
}

/** 视觉文本：把 aria-hidden 的分隔符 span（.sep / margin: 0 10px）建模为一个前置空格。 */
function flattenVisibleText(node) {
  if (Array.isArray(node)) return node.map(flattenVisibleText).join("");
  if (isElement(node)) {
    const inner = node.children.map(flattenVisibleText).join("");
    return node.props && node.props["aria-hidden"] === "true" ? " " + inner : inner;
  }
  return flattenText(node);
}

function describeTree(node) {
  if (node === null) return "null";
  if (node === undefined) return "undefined";
  if (isElement(node)) return "<" + node.type + ">" + describeValue(flattenText(node));
  return describeValue(node);
}

function childElements(tree) {
  const children = tree && Array.isArray(tree.children) ? tree.children : [];
  return children.filter(isElement);
}

/** 卡片内的用量区块（按 data-block 标识，排除底栏与设置面板）。 */
function usageBlocks(tree) {
  return childElements(tree).filter((node) => typeof node.props["data-block"] === "string");
}

/** 卡片底部的操作栏。 */
function footerOf(tree) {
  return childElements(tree).find((node) => node.props["data-footer"] === "1") || null;
}

/** 展开的设置面板（带 data-no-drag）。 */
function panelOf(tree) {
  return childElements(tree).find((node) => node.props["data-no-drag"] === "1") || null;
}

/** 深度收集渲染树中的所有 button（out 可省略）。 */
function collectButtons(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectButtons(item, out);
    return out;
  }
  if (!isElement(node)) return out;
  if (node.type === "button") out.push(node);
  for (const child of node.children) collectButtons(child, out);
  return out;
}

/** 按可见文本找一个 button。 */
function buttonByText(node, text) {
  return collectButtons(node, []).find((btn) => flattenText(btn) === text) || null;
}

/** 按 aria-label 找一个 button（图标按钮没有文本）。 */
function buttonByLabel(node, label) {
  return collectButtons(node, []).find((btn) => btn.props["aria-label"] === label) || null;
}

/** 区块内的第 n 个直接子元素（0=标签行 head，1=进度条轨道 track）。 */
function blockPart(block, index) {
  return childElements(block)[index];
}

/** 标签行内的第 n 个子元素（0=标签，1=百分比徽章，2=倒计时，倒计时可能缺失）。 */
function headPart(block, index) {
  return childElements(blockPart(block, 0))[index];
}

/** 进度条轨道内的填充条。 */
function blockFill(block) {
  return childElements(blockPart(block, 1))[0];
}

// ===== client 沙箱 =====
function buildClientEnv() {
  const rec = {
    loaded: null,
    responses: [],
    fetchCalls: [],
    intervals: [],
    clearedIntervals: [],
    timeouts: [],
    clearedTimeouts: [],
    nextTimerId: 1,
    clipboardWrites: [],
    windowListeners: {},
    storage: new Map(),
    injectedStyles: [],
    sandbox: null,
    react: null,
    module: null,
    component: null,
    ctx: null,
    slotRecords: {
      injectKeys: [],
      injectReturns: [],
      registrations: [],
      disposerCalls: 0,
    },
  };

  rec.pushResponse = function pushResponse(response) {
    rec.responses.push(response);
    return rec;
  };

  const windowObject = {
    __ModuleLoader__: {
      load: function load(handoff) {
        rec.loaded = handoff;
      },
    },
    fetch: function fetch(url, init) {
      rec.fetchCalls.push({ url: url, init: init || {} });
      if (rec.responses.length === 0) {
        // 队列为空：返回永不 settle 的 promise，模拟"数据还没回来"。
        return new Promise(function pending() {});
      }
      return Promise.resolve(rec.responses.shift());
    },
    setInterval: function setInterval(fn, ms) {
      const id = rec.nextTimerId;
      rec.nextTimerId += 1;
      rec.intervals.push({ id: id, fn: fn, ms: ms });
      return id;
    },
    clearInterval: function clearInterval(id) {
      rec.clearedIntervals.push(id);
    },
    setTimeout: function setTimeout(fn, ms) {
      const id = rec.nextTimerId;
      rec.nextTimerId += 1;
      rec.timeouts.push({ id: id, fn: fn, ms: ms });
      return id;
    },
    clearTimeout: function clearTimeout(id) {
      rec.clearedTimeouts.push(id);
    },
    localStorage: {
      getItem: function getItem(key) {
        return rec.storage.has(key) ? rec.storage.get(key) : null;
      },
      setItem: function setItem(key, value) {
        rec.storage.set(key, String(value));
      },
      removeItem: function removeItem(key) {
        rec.storage.delete(key);
      },
    },
    innerWidth: 1200,
    innerHeight: 800,
    navigator: {
      clipboard: {
        writeText: function writeText(text) {
          rec.clipboardWrites.push(text);
          return Promise.resolve();
        },
      },
    },
    addEventListener: function addEventListener(type, fn) {
      (rec.windowListeners[type] = rec.windowListeners[type] || []).push(fn);
    },
    removeEventListener: function removeEventListener(type, fn) {
      const list = rec.windowListeners[type] || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
  };

  // client 半的剪贴板回退路径会用到 document；样式注入走 head。
  const documentObject = {
    createElement: function createElement(tag) {
      return {
        tag: tag,
        id: "",
        textContent: "",
        value: "",
        style: {},
        setAttribute: function setAttribute() {},
        select: function select() {},
      };
    },
    head: {
      appendChild: function appendChild(el) {
        rec.injectedStyles.push(el);
      },
    },
    body: {
      appendChild: function appendChild() {},
      removeChild: function removeChild() {},
    },
    getElementById: function getElementById() {
      return null;
    },
    execCommand: function execCommand() {
      return true;
    },
  };

  const sandbox = {
    window: windowObject,
    document: documentObject,
    console: console,
    // 浏览器有 AbortController，宿主半/客户端半都会据此武装请求超时。
    AbortController: AbortController,
  };
  vm.createContext(sandbox);
  rec.sandbox = sandbox;
  return rec;
}

/** 执行 client bundle 并调用 factory（不 apply）。 */
function loadClientModule(env) {
  vm.runInContext(CLIENT_BUNDLE, env.sandbox, { filename: "client.js" });
  check(env.loaded !== null, "bundle 没有调用 window.__ModuleLoader__.load");
  env.react = createReactStub();
  env.module = env.loaded.factory(function requireStub(id) {
    if (id === "react") return env.react.React;
    throw new Error("client bundle 请求了未预期的模块: " + String(id));
  });
  check(env.module !== null && typeof env.module === "object", "factory 没有返回 exports 对象");
  return env.module;
}

/** 构造假 ctx 并 apply，捕获 slots.inject / slots.register 的调用。 */
function applyClient(env) {
  const slotRecords = env.slotRecords;
  env.ctx = {
    slots: {
      inject: function inject(key, callback) {
        slotRecords.injectKeys.push(key);
        const value = callback();
        slotRecords.injectReturns.push(value);
        return value;
      },
      register: function register(options, component) {
        slotRecords.registrations.push({ options: options, component: component });
        return function disposeSlot() {
          slotRecords.disposerCalls += 1;
        };
      },
    },
  };
  env.module.apply(env.ctx);
  check(
    slotRecords.registrations.length === 1,
    "apply 未注册组件（注册数 " + slotRecords.registrations.length + "）"
  );
  env.component = slotRecords.registrations[0].component;
  return env;
}

function bootClient(env) {
  const target = env === undefined ? buildClientEnv() : env;
  loadClientModule(target);
  applyClient(target);
  return target;
}

/** 挂载：首渲染 + 提交后运行 effect（React 的 useEffect 时机）。 */
function mountClient(env) {
  const record = env.react.__createRoot(env.component);
  record.render();
  for (let i = 0; i < record.effects.length; i += 1) {
    const cleanup = record.effects[i].fn();
    if (typeof cleanup === "function") record.cleanups.push(cleanup);
  }
  return record;
}

/** 等微任务跑完（取数链路是纯 promise 链），然后按最新快照重渲染。 */
async function settleClient(record) {
  await flushMicrotasks();
  await flushMicrotasks();
  return record.render();
}

/** 卸载：退订 store + 逆序执行 effect cleanup。 */
function unmountClient(record) {
  if (typeof record.unsubscribe === "function") {
    record.unsubscribe();
    record.unsubscribe = null;
  }
  for (let i = record.cleanups.length - 1; i >= 0; i -= 1) record.cleanups[i]();
  record.cleanups = [];
}

// ===== host 辅助 =====
const upstream = { calls: [], queue: [] };

/** 打桩全局 fetch（lib/index.js 用的是全局 fetch）。 */
function installUpstreamFetchStub() {
  globalThis.fetch = function fetch(url, init) {
    upstream.calls.push({ url: String(url), init: init || {} });
    if (upstream.queue.length === 0) {
      return Promise.reject(new Error("verify: 上游 fetch 被调用但没有预置响应"));
    }
    return Promise.resolve(upstream.queue.shift());
  };
}

function pushUpstream(status, body) {
  upstream.queue.push({
    ok: status >= 200 && status < 300,
    status: status,
    json: function json() {
      return Promise.resolve(body);
    },
  });
}

function resetUpstream() {
  upstream.calls.length = 0;
  upstream.queue.length = 0;
}

function toFileUrl(filePath) {
  let normalized = filePath.split("\\").join("/");
  if (normalized.charAt(0) !== "/") normalized = "/" + normalized;
  return "file://" + encodeURI(normalized);
}

let hostImportSeq = 0;
/** 每次都用不同的 query 重新 import，拿到干净的模块级 cache。 */
function importHostModule() {
  hostImportSeq += 1;
  return import(toFileUrl(HOST_ENTRY) + "?case=" + hostImportSeq);
}

function createHostCtx(options) {
  const settings = options === undefined ? {} : options;
  const rec = { effectLabels: [], effectDisposers: [], routes: [], disposeCalls: 0, credentialRefs: [] };
  const ctx = {
    effect: function effect(fn, label) {
      rec.effectLabels.push(label);
      const dispose = fn();
      rec.effectDisposers.push(dispose);
      return dispose;
    },
    // cordis 的惰性服务查找：只提供 settings.credentials（未给则为 undefined）。
    get: function get(name) {
      if (name !== "credentials") return undefined;
      if (typeof settings.credentials === "function") return settings.credentials(rec);
      return settings.credentials;
    },
    webServer: {
      register: function register(route) {
        rec.routes.push(route);
        return function disposeRoute() {
          rec.disposeCalls += 1;
        };
      },
    },
  };
  return { ctx: ctx, rec: rec };
}

function makeRes() {
  return {
    status: null,
    headers: null,
    body: undefined,
    ended: false,
    writeHead: function writeHead(status, headers) {
      this.status = status;
      this.headers = headers === undefined ? null : headers;
      return this;
    },
    end: function end(body) {
      this.body = body;
      this.ended = true;
      return this;
    },
  };
}

async function callRoute(route, req) {
  const res = makeRes();
  await route.handler(req, res);
  return res;
}

function parseJsonBody(res) {
  check(typeof res.body === "string" && res.body.length > 0, "响应体应为非空字符串，实际 " + describeValue(res.body));
  try {
    return JSON.parse(res.body);
  } catch (error) {
    throw new Error("响应体不是合法 JSON: " + res.body);
  }
}

/** 上游当前结构（{usage:{...}}）。 */
const UPSTREAM_USAGE = {
  usage: {
    rolling: { status: "ok", percent: 4, resetsAt: "2026-08-13T16:27:38.287Z" },
    weekly: { status: "ok", percent: 3, resetsAt: "2026-08-17T00:00:00.000Z" },
    monthly: { status: "ok", percent: 1, resetsAt: "2026-09-13T06:06:01.287Z" },
  },
};

/** 宿主归一化后的期望窗口。 */
const HOST_EXPECTED_WINDOWS = [
  {
    key: "rolling",
    label: "Rolling usage",
    status: "ok",
    percent: 4,
    remainingPercent: 96,
    resetsAt: "2026-08-13T16:27:38.287Z",
  },
  {
    key: "weekly",
    label: "Weekly usage",
    status: "ok",
    percent: 3,
    remainingPercent: 97,
    resetsAt: "2026-08-17T00:00:00.000Z",
  },
  {
    key: "monthly",
    label: "Monthly usage",
    status: "ok",
    percent: 1,
    remainingPercent: 99,
    resetsAt: "2026-09-13T06:06:01.287Z",
  },
];

// ===== 主流程 =====
(async function main() {
  console.log("dsh-opencode-go-usage 行为验证\n");

  const savedEnv = {
    OPENCODE_GO_API_KEY: process.env.OPENCODE_GO_API_KEY,
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
    OPENCODE_AUTH_CONTENT: process.env.OPENCODE_AUTH_CONTENT,
  };
  process.env.OPENCODE_GO_API_KEY = "test-key";
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_AUTH_CONTENT;

  installUpstreamFetchStub();

  try {
    // ---------- Part A：client 半 ----------

    await runCase("A1 client：factory 注册 id 与导出形态（name/inject/apply）", async () => {
      const env = buildClientEnv();
      loadClientModule(env);

      check(
        env.loaded !== null && env.loaded.id === "dsh-opencode-go-usage",
        "module id 不符: " + describeValue(env.loaded && env.loaded.id)
      );
      check(typeof env.loaded.factory === "function", "factory 不是函数");

      const mod = env.module;
      check(mod.name === "opencode-go-usage", "exports.name 不符: " + describeValue(mod.name));
      check(
        deepEqual(mod.inject, ["slots"]),
        "exports.inject 应为 [\"slots\"]，实际 " + describeValue(mod.inject)
      );
      check(typeof mod.apply === "function", "exports.apply 不是函数");

      // 状态样式（hover / 拖动光标）随 bundle 物化注入一张样式表。
      check(env.injectedStyles.length === 1, "应注入一张样式表，实际 " + env.injectedStyles.length);
      const sheet = env.injectedStyles[0];
      check(sheet.id === "dsh-opencode-go-usage-style", "样式表 id 不符：" + describeValue(sheet.id));
      check(sheet.textContent.indexOf(".dsh-ogu-icon:hover") >= 0, "样式表应含图标 hover 规则");
      check(sheet.textContent.indexOf("[data-dragging='1']") >= 0, "样式表应含拖动光标规则");
    });

    await runCase("A2 client：apply 注入 shell.overlay 并注册 order 100", async () => {
      const env = buildClientEnv();
      loadClientModule(env);
      applyClient(env);

      const records = env.slotRecords;
      check(
        records.injectKeys.length === 1 && records.injectKeys[0] === "shell.overlay",
        "slots.inject 的座席名不符: " + describeValue(records.injectKeys)
      );
      check(records.registrations.length === 1, "slots.register 调用次数应为 1，实际 " + records.registrations.length);

      const registration = records.registrations[0];
      check(
        registration.options.id === "opencode-go-usage",
        "注册 id 不符: " + describeValue(registration.options.id)
      );
      check(
        registration.options.order === 100,
        "注册 order 应为 100，实际 " + describeValue(registration.options.order)
      );
      check(
        registration.options.name === "shell.overlay",
        "注册 name 不符: " + describeValue(registration.options.name)
      );
      check(typeof registration.component === "function", "注册的组件不是函数");
      // inject 回调应把 register 的 disposer 透传回去，DSH 才能注销该座席。
      check(
        typeof records.injectReturns[0] === "function",
        "slots.inject 回调应返回 register 的 disposer，实际 " + describeValue(records.injectReturns[0])
      );
    });

    await runCase("A3 client：首挂载无数据时渲染 null（不占位）", async () => {
      const env = bootClient();
      const record = mountClient(env);

      check(record.tree === null, "首挂载应返回 null，实际 " + describeTree(record.tree));

      await settleClient(record);
      check(record.tree === null, "数据尚未到达时应保持 null，实际 " + describeTree(record.tree));
      check(env.fetchCalls.length === 1, "挂载后应发出一次取数请求，实际 " + env.fetchCalls.length);
      check(record.notifications === 0, "无数据变化时不应收到 store 通知，实际 " + record.notifications);
    });

    await runCase("A4 client：三行结构（标签/徽章/倒计时/进度条）与卡片样式", async () => {
      const env = bootClient();
      env.pushResponse(jsonResponse(200, { ok: true, windows: cloneWindows() }));
      const record = mountClient(env);
      await settleClient(record);

      check(record.notifications >= 1, "数据到达后组件未收到 store 通知（useSyncExternalStore 订阅未接上）");
      check(env.fetchCalls.length === 1, "应只发出一次取数请求，实际 " + env.fetchCalls.length);
      check(isElement(record.tree), "成功取数后应渲染元素，实际 " + describeTree(record.tree));
      check(record.tree.type === "div", "根元素应为 div，实际 " + describeValue(record.tree.type));

      // 卡片外框：矩形浮窗，走 DSH 的 menu surface token。
      const style = record.tree.props.style;
      checkStyleValue(style, "position", "absolute", "卡片样式");
      checkStyleValue(style, "borderRadius", "12px", "卡片样式");
      checkStyleValue(style, "background", "var(--dsw-specific-menu)", "卡片样式");
      checkStyleValue(style, "boxShadow", "var(--dsw-shadow-lv3)", "卡片样式");
      checkStyleValue(style, "border", "1px solid var(--dsw-alias-border-l1)", "卡片样式");
      checkStyleValue(style, "fontSize", "12px", "卡片样式");

      const blocks = usageBlocks(record.tree);
      check(blocks.length === 3, "应渲染 3 个窗口区块，实际 " + blocks.length);

      for (let i = 0; i < blocks.length; i += 1) {
        const label = headPart(blocks[i], 0);
        const badge = headPart(blocks[i], 1);
        const resets = headPart(blocks[i], 2);

        check(
          flattenText(label) === WINDOW_LABELS[i],
          "第 " + (i + 1) + " 行标签不符：" + describeValue(flattenText(label)) +
            "，期望 " + describeValue(WINDOW_LABELS[i])
        );
        check(
          flattenText(badge) === WINDOW_PERCENT_TEXTS[i],
          "第 " + (i + 1) + " 行徽章文本不符：" + describeValue(flattenText(badge)) +
            "，期望 " + describeValue(WINDOW_PERCENT_TEXTS[i])
        );
        // 徽章：浅色底 + success 描边与文字。
        checkStyleValue(badge.props.style, "color", "var(--dsw-alias-state-success-primary)", "徽章样式");
        checkStyleValue(badge.props.style, "background", "var(--dsw-alias-state-success-tertiary)", "徽章样式");
        checkStyleValue(badge.props.style, "border", "1px solid var(--dsw-alias-state-success-secondary)", "徽章样式");
        checkStyleValue(badge.props.style, "borderRadius", "6px", "徽章样式");

        check(resets !== undefined && isElement(resets), "第 " + (i + 1) + " 行应有重置倒计时");
        check(
          RESET_PATTERN.test(flattenText(resets)),
          "第 " + (i + 1) + " 行倒计时格式不符：" + describeValue(flattenText(resets))
        );
        check(
          flattenText(resets).indexOf(RESET_PREFIXES[i]) === 0,
          "第 " + (i + 1) + " 行倒计时量级不符：" + describeValue(flattenText(resets)) +
            "，期望以 " + describeValue(RESET_PREFIXES[i]) + " 开头"
        );
        checkStyleValue(resets.props.style, "marginLeft", "auto", "倒计时样式");
        checkStyleValue(resets.props.style, "color", "var(--dsw-alias-label-tertiary)", "倒计时样式");

        // 进度条：轨道 + 按百分比宽度的填充。
        const track = blockPart(blocks[i], 1);
        checkStyleValue(track.props.style, "borderRadius", "999px", "进度轨道");
        checkStyleValue(track.props.style, "background", "var(--dsw-alias-interactive-bg-hover)", "进度轨道");
        const fill = blockFill(blocks[i]);
        check(isElement(fill), "第 " + (i + 1) + " 行应有进度条填充");
        checkStyleValue(fill.props.style, "width", WINDOW_PERCENT_TEXTS[i], "进度填充宽度");
        checkStyleValue(fill.props.style, "background", "var(--dsw-alias-state-success-primary)", "进度填充色");

        // 行间分隔：首行无上边框，其余行有发丝线。
        if (i === 0) {
          check(blocks[i].props.style.borderTop === undefined, "首行不应有上分隔线");
        } else {
          checkStyleValue(blocks[i].props.style, "borderTop", "1px solid var(--dsw-alias-border-l2)", "行分隔线");
        }
      }
    });

    await runCase("A5 client：打满窗口的徽章与填充转 error 语义色", async () => {
      // 5a：percent 100 → 徽章与填充都转 error 色
      const envA = bootClient();
      const windowsA = cloneWindows();
      windowsA[0] = Object.assign({}, windowsA[0], {
        status: "rate-limited",
        percent: 100,
        remainingPercent: 0,
      });
      envA.pushResponse(jsonResponse(200, { ok: true, windows: windowsA }));
      const recordA = mountClient(envA);
      await settleClient(recordA);

      const blocksA = usageBlocks(recordA.tree);
      check(blocksA.length === 3, "应渲染 3 个窗口区块，实际 " + blocksA.length);
      const badgeA = headPart(blocksA[0], 1);
      check(flattenText(badgeA) === "100%", "打满徽章文本不符：" + describeValue(flattenText(badgeA)));
      checkStyleValue(badgeA.props.style, "color", "var(--dsw-alias-state-error-primary)", "percent=100 徽章");
      checkStyleValue(badgeA.props.style, "background", "transparent", "percent=100 徽章");
      checkStyleValue(
        blockFill(blocksA[0]).props.style,
        "background",
        "var(--dsw-alias-state-error-primary)",
        "percent=100 进度填充"
      );
      for (const i of [1, 2]) {
        checkStyleValue(
          headPart(blocksA[i], 1).props.style, "color",
          "var(--dsw-alias-state-success-primary)", "未打满徽章"
        );
        checkStyleValue(
          blockFill(blocksA[i]).props.style, "background",
          "var(--dsw-alias-state-success-primary)", "未打满填充"
        );
      }

      // 5b：status rate-limited（percent 未满）同样视为打满
      const envB = bootClient();
      const windowsB = cloneWindows();
      windowsB[1] = Object.assign({}, windowsB[1], { status: "rate-limited" });
      envB.pushResponse(jsonResponse(200, { ok: true, windows: windowsB }));
      const recordB = mountClient(envB);
      await settleClient(recordB);

      const blocksB = usageBlocks(recordB.tree);
      check(blocksB.length === 3, "应渲染 3 个窗口区块，实际 " + blocksB.length);
      checkStyleValue(
        headPart(blocksB[1], 1).props.style, "color",
        "var(--dsw-alias-state-error-primary)", "rate-limited 徽章"
      );
      checkStyleValue(
        blockFill(blocksB[1]).props.style, "background",
        "var(--dsw-alias-state-error-primary)", "rate-limited 填充"
      );
      for (const i of [0, 2]) {
        checkStyleValue(
          headPart(blocksB[i], 1).props.style, "color",
          "var(--dsw-alias-state-success-primary)", "非 rate-limited 徽章"
        );
      }
    });

    await runCase("A6 client：首次取数失败且无历史数据时渲染不可用提示", async () => {
      const env = bootClient();
      env.pushResponse(jsonResponse(502, { ok: false, error: "上游返回 HTTP 502", windows: [] }));
      const record = mountClient(env);
      await settleClient(record);

      check(env.fetchCalls.length === 1, "应发出一次取数请求，实际 " + env.fetchCalls.length);
      check(isElement(record.tree), "错误态应渲染提示元素，实际 " + describeTree(record.tree));
      check(record.tree.type === "div", "错误态根元素应为 div，实际 " + describeValue(record.tree.type));
      check(
        flattenText(record.tree) === "opencode Go usage 不可用",
        "错误文案不符：" + describeValue(flattenText(record.tree))
      );
      check(
        record.tree.props.title === "上游返回 HTTP 502",
        "错误态 title 应为上游错误原文，实际 " + describeValue(record.tree.props.title)
      );
    });

    await runCase("A7 client：成功后再失败保留旧读数（卡片不闪空白）", async () => {
      const env = bootClient();
      env.pushResponse(jsonResponse(200, { ok: true, windows: cloneWindows() }));
      const record = mountClient(env);
      await settleClient(record);
      check(usageBlocks(record.tree).length === 3, "首次成功应渲染三个窗口区块");

      check(env.intervals.length === 1, "应注册轮询定时器，实际 " + env.intervals.length);
      env.pushResponse(jsonResponse(502, { ok: false, error: "上游返回 HTTP 502", windows: [] }));
      env.intervals[0].fn();
      await settleClient(record);
      check(env.fetchCalls.length === 2, "轮询回调应发出第二次请求，实际 " + env.fetchCalls.length);

      check(isElement(record.tree), "第二次失败后卡片不应消失，实际 " + describeTree(record.tree));
      const keptBlocks = usageBlocks(record.tree);
      check(keptBlocks.length === 3, "失败后应保留旧读数（3 个区块），实际 " + keptBlocks.length);
      check(flattenText(headPart(keptBlocks[0], 1)) === "4%", "失败后应保留旧百分比");
      check(
        typeof record.tree.props.title === "string" &&
          record.tree.props.title.indexOf("上次刷新失败：上游返回 HTTP 502") >= 0,
        "tooltip 应记录上次失败原因，实际 " + describeValue(record.tree.props.title)
      );
    });

    await runCase("A8 client：挂载启动 60s 轮询、回调再取数、卸载清理订阅与定时器", async () => {
      const env = bootClient();
      env.pushResponse(jsonResponse(200, { ok: true, windows: cloneWindows() }));
      const record = mountClient(env);

      check(env.intervals.length === 1, "挂载应注册 1 个 setInterval，实际 " + env.intervals.length);
      check(
        env.intervals[0].ms === 60000,
        "轮询间隔应为 60000ms，实际 " + describeValue(env.intervals[0].ms)
      );
      const intervalId = env.intervals[0].id;

      await settleClient(record);
      check(env.fetchCalls.length === 1, "挂载应触发一次取数，实际 " + env.fetchCalls.length);

      env.pushResponse(jsonResponse(200, { ok: true, windows: cloneWindows() }));
      env.intervals[0].fn();
      await settleClient(record);
      check(env.fetchCalls.length === 2, "轮询回调应再次取数，实际 " + env.fetchCalls.length);

      const notificationsBefore = record.notifications;
      check(notificationsBefore >= 1, "取数成功后应收到过 store 通知，实际 " + notificationsBefore);

      unmountClient(record);
      check(
        env.clearedIntervals.indexOf(intervalId) >= 0,
        "卸载应 clearInterval(" + intervalId + ")，实际 " + describeValue(env.clearedIntervals)
      );

      // 卸载后 store 再变化，不应再通知已卸载的组件（订阅已被释放）。
      env.pushResponse(jsonResponse(200, { ok: true, windows: cloneWindows() }));
      env.intervals[0].fn();
      await flushMicrotasks();
      await flushMicrotasks();
      check(
        record.notifications === notificationsBefore,
        "卸载后不应再收到 store 通知，实际 " + record.notifications + "，卸载前 " + notificationsBefore
      );
    });

    await runCase("A9 client：请求同源路由 /opencode-go-usage 且 cache: no-store", async () => {
      const env = bootClient();
      env.pushResponse(jsonResponse(200, { ok: true, windows: cloneWindows() }));
      const record = mountClient(env);
      await settleClient(record);

      check(env.fetchCalls.length === 1, "应发出一次取数请求，实际 " + env.fetchCalls.length);
      const call = env.fetchCalls[0];
      check(call.url === ROUTE_PATH, "请求 URL 应为 " + ROUTE_PATH + "，实际 " + describeValue(call.url));
      check(call.init.cache === "no-store", "cache 应为 no-store，实际 " + describeValue(call.init.cache));
      check(call.init.method === "GET", "method 应为 GET，实际 " + describeValue(call.init.method));
      check(
        call.init.headers !== undefined && call.init.headers.accept === "application/json",
        "应声明 accept: application/json，实际 " + describeValue(call.init.headers)
      );

      // 代码在 AbortController 可用时会武装 20s 请求超时，并在链路结束后清理。
      check(env.timeouts.length === 1, "应武装一次请求超时，实际 " + env.timeouts.length);
      check(env.timeouts[0].ms === 20000, "请求超时应为 20000ms，实际 " + describeValue(env.timeouts[0].ms));
      check(
        env.clearedTimeouts.indexOf(env.timeouts[0].id) >= 0,
        "取数链路结束后应 clearTimeout，实际 " + describeValue(env.clearedTimeouts)
      );
    });

    await runCase("A10 client：卡片拖动（阈值判定 + 位置落盘 + 重渲染改用 left/top）", async () => {
      const env = bootClient();
      env.pushResponse(jsonResponse(200, { ok: true, windows: cloneWindows() }));
      const record = mountClient(env);
      await settleClient(record);

      check(usageBlocks(record.tree).length === 3, "应先渲染三行");
      check(
        typeof record.tree.props.onPointerDown === "function",
        "卡片应绑定 onPointerDown 以支持拖动"
      );

      // 可读写的假卡片元素：位置由闭包变量模拟。
      let at = { x: 700, y: 500 };
      const style = {};
      const attrs = {};
      const element = {
        style: style,
        setAttribute: function setAttribute(name, value) {
          attrs[name] = String(value);
        },
        removeAttribute: function removeAttribute(name) {
          delete attrs[name];
        },
        getBoundingClientRect: function getBoundingClientRect() {
          return { left: at.x, top: at.y, width: 320, height: 160 };
        },
      };

      record.tree.props.onPointerDown({
        button: 0,
        clientX: 700,
        clientY: 500,
        currentTarget: element,
        target: null,
        preventDefault: function preventDefault() {},
      });
      check((env.windowListeners.pointermove || []).length === 1, "pointerdown 应注册 pointermove");
      check((env.windowListeners.pointerup || []).length === 1, "pointerdown 应注册 pointerup");

      // 位移 2px：低于 4px 阈值 → 不算拖动，不落盘。
      (env.windowListeners.pointermove || []).forEach(function (fn) {
        fn({ clientX: 702, clientY: 501, preventDefault: function preventDefault() {} });
      });
      check(!env.storage.has("dsh.opencodeGoUsage.pos"), "低于阈值的位移不应落盘");

      // 位移 (60, 40)：算拖动 → 直接改元素样式。
      (env.windowListeners.pointermove || []).forEach(function (fn) {
        fn({ clientX: 760, clientY: 540, preventDefault: function preventDefault() {} });
      });
      check(
        style.left === "760px" && style.top === "540px",
        "拖动应更新 left/top，实际 " + describeValue([style.left, style.top])
      );
      check(style.right === "auto" && style.bottom === "auto", "拖动后应清掉 right/bottom");
      check(attrs["data-dragging"] === "1", "拖动中应标 data-dragging（抓手光标）");

      // 松手：写 store + localStorage，并摘掉监听。
      at = { x: 760, y: 540 };
      (env.windowListeners.pointerup || []).forEach(function (fn) {
        fn({});
      });
      const stored = env.storage.get("dsh.opencodeGoUsage.pos");
      check(
        stored === JSON.stringify({ x: 760, y: 540 }),
        "位置应落盘为 " + describeValue(JSON.stringify({ x: 760, y: 540 })) + "，实际 " + describeValue(stored)
      );
      check((env.windowListeners.pointermove || []).length === 0, "松手应移除 pointermove 监听");
      check(attrs["data-dragging"] === undefined, "松手应移除 data-dragging");

      // 重渲染：卡片改用 left/top 定位。
      record.render();
      check(
        record.tree.props.style.left === "760px" && record.tree.props.style.top === "540px",
        "重渲染应使用拖动后的坐标，实际 " +
          describeValue([record.tree.props.style.left, record.tree.props.style.top])
      );
      check(
        record.tree.props.style.right === "auto" && record.tree.props.style.bottom === "auto",
        "重渲染应清掉 right/bottom"
      );
    });

    await runCase("A11 client：设置面板可改查询间隔并立即重建轮询", async () => {
      const env = bootClient();
      env.pushResponse(jsonResponse(200, { ok: true, windows: cloneWindows() }));
      const record = mountClient(env);
      await settleClient(record);

      check(
        env.intervals.length === 1 && env.intervals[0].ms === 60000,
        "默认间隔应为 60s，实际 " + describeValue(env.intervals.map(function (i) { return i.ms; }))
      );
      check(panelOf(record.tree) === null, "默认应关闭设置面板");

      const toggle = buttonByLabel(footerOf(record.tree), "设置");
      check(toggle !== null, "底栏应有设置按钮（图标按钮，按 aria-label 定位）");
      check(toggle.props.className === "dsh-ogu-icon", "设置按钮应使用图标按钮类");
      check(flattenText(toggle) === "", "图标按钮不应带文字，只放齿轮");
      check(toggle.props["data-active"] === "0", "收起时 data-active 应为 0");
      toggle.props.onClick();
      record.render();

      const toggleOpen = buttonByLabel(footerOf(record.tree), "设置");
      check(toggleOpen.props["data-active"] === "1", "展开后 data-active 应为 1");
      check(toggleOpen.props["aria-expanded"] === "true", "展开后 aria-expanded 应为 true");

      const panel = panelOf(record.tree);
      check(panel !== null, "点「设置」应展开面板");
      check(panel.props["data-no-drag"] === "1", "面板应标 data-no-drag，避免面板内误触拖动");

      const chips = collectButtons(panel);
      const labels = chips.map(function (b) { return flattenText(b); });
      check(labels.indexOf("5m") >= 0, "面板应提供 5m 选项，实际 " + describeValue(labels));
      const active = chips.find(function (b) { return flattenText(b) === "1m"; });
      check(
        active !== undefined && active.props.style.fontWeight === "500",
        "当前间隔 chip 应为选中态"
      );

      // 选 5m：落盘 + 立即以新间隔重建定时器。
      const five = chips.find(function (b) { return flattenText(b) === "5m"; });
      five.props.onClick();
      check(
        env.storage.get("dsh.opencodeGoUsage.intervalMs") === "300000",
        "间隔应落盘，实际 " + describeValue(env.storage.get("dsh.opencodeGoUsage.intervalMs"))
      );
      const last = env.intervals[env.intervals.length - 1];
      check(
        last.ms === 300000,
        "应以新间隔重建定时器，实际 " + describeValue(env.intervals.map(function (i) { return i.ms; }))
      );
      check(env.clearedIntervals.length >= 1, "重建前应先清掉旧定时器");

      // 重渲染后该 chip 变选中、1m 取消选中。
      record.render();
      const after = collectButtons(panelOf(record.tree));
      check(
        after.find(function (b) { return flattenText(b) === "5m"; }).props.style.fontWeight === "500",
        "5m 应变为选中态"
      );
      check(
        after.find(function (b) { return flattenText(b) === "1m"; }).props.style.fontWeight !== "500",
        "1m 应取消选中"
      );
    });

    await runCase("A12 client：查看 API Key（脱敏 → 明文）与复制", async () => {
      const env = bootClient();
      env.pushResponse(jsonResponse(200, { ok: true, windows: cloneWindows() }));
      const record = mountClient(env);
      await settleClient(record);
      buttonByLabel(footerOf(record.tree), "设置").props.onClick();
      record.render();

      // 未查看前只显示掩码，且不发请求。
      let panel = panelOf(record.tree);
      check(panel !== null, "面板应展开");
      check(flattenText(panel).indexOf("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022") >= 0, "未查看时应显示掩码");
      const viewBtn = buttonByText(panel, "查看");
      check(viewBtn !== null, "应有「查看」按钮");
      check(env.fetchCalls.length === 1, "查看前不应请求凭据，实际 " + env.fetchCalls.length);

      // 点「查看」→ 打 /opencode-go-usage/key。
      env.pushResponse(
        jsonResponse(200, {
          ok: true,
          key: SECRET_KEY,
          masked: MASKED_KEY,
          source: "OPENCODE_GO_API_KEY",
          length: SECRET_KEY.length,
        })
      );
      viewBtn.props.onClick();
      await settleClient(record);

      check(env.fetchCalls.length === 2, "查看应请求一次凭据，实际 " + env.fetchCalls.length);
      check(
        env.fetchCalls[1].url === ROUTE_PATH + "/key",
        "凭据路由不符：" + describeValue(env.fetchCalls[1].url)
      );

      panel = panelOf(record.tree);
      check(flattenText(panel).indexOf(MASKED_KEY) >= 0, "应显示脱敏 Key，实际 " + describeValue(flattenText(panel)));
      check(flattenText(panel).indexOf(SECRET_KEY) < 0, "默认不应显示明文");
      check(flattenText(panel).indexOf("来源：OPENCODE_GO_API_KEY") >= 0, "应显示来源");

      // 「显示」切明文。
      buttonByText(panel, "显示").props.onClick();
      record.render();
      panel = panelOf(record.tree);
      check(flattenText(panel).indexOf(SECRET_KEY) >= 0, "点「显示」后应出现明文");
      check(buttonByText(panel, "隐藏") !== null, "显示后按钮应变为「隐藏」");

      // 「复制」写入剪贴板（明文）。
      buttonByText(panel, "复制").props.onClick();
      await flushMicrotasks();
      check(env.clipboardWrites.length === 1, "应写入剪贴板一次，实际 " + env.clipboardWrites.length);
      check(env.clipboardWrites[0] === SECRET_KEY, "剪贴板内容应为完整 Key");
      record.render();
      check(buttonByText(panelOf(record.tree), "已复制") !== null, "复制后按钮应短暂显示「已复制」");
    });

    await runCase("A13 client：宿主换 Key 后面板里的凭据自动跟进", async () => {
      const env = bootClient();
      env.pushResponse(jsonResponse(200, { ok: true, windows: cloneWindows(), keyMasked: MASKED_KEY }));
      const record = mountClient(env);
      await settleClient(record);

      buttonByLabel(footerOf(record.tree), "设置").props.onClick();
      record.render();
      env.pushResponse(
        jsonResponse(200, {
          ok: true,
          key: SECRET_KEY,
          masked: MASKED_KEY,
          source: "OPENCODE_GO_API_KEY",
          length: SECRET_KEY.length,
        })
      );
      buttonByText(panelOf(record.tree), "查看").props.onClick();
      await settleClient(record);
      check(env.fetchCalls.length === 2, "查看应请求一次凭据，实际 " + env.fetchCalls.length);
      check(
        flattenText(panelOf(record.tree)).indexOf(MASKED_KEY) >= 0,
        "查看后应显示当前 Key 的脱敏值，实际 " + describeValue(flattenText(panelOf(record.tree)))
      );

      // 下一轮轮询：宿主报告的 keyMasked 变了（用户刚在 DSH 里换了 Key）。
      const nextKey = "sk-secondkey00000000000000000000000009";
      const nextMasked = nextKey.slice(0, 6) + "\u2026" + nextKey.slice(-4);
      env.pushResponse(jsonResponse(200, { ok: true, windows: cloneWindows(), keyMasked: nextMasked }));
      env.pushResponse(
        jsonResponse(200, {
          ok: true,
          key: nextKey,
          masked: nextMasked,
          source: "OPENCODE_GO_API_KEY（DSH 凭据 / file）",
          length: nextKey.length,
        })
      );
      const poller = env.intervals[env.intervals.length - 1];
      check(typeof poller.fn === "function", "应已启动轮询定时器");
      poller.fn();
      await settleClient(record);
      await settleClient(record);

      check(env.fetchCalls.length === 4, "换 Key 后应自动再取一次凭据，实际 " + env.fetchCalls.length);
      check(
        env.fetchCalls[3].url === ROUTE_PATH + "/key",
        "自动重取应打凭据路由，实际 " + describeValue(env.fetchCalls[3].url)
      );
      const after = panelOf(record.tree);
      check(
        flattenText(after).indexOf(nextMasked) >= 0,
        "面板应换成新 Key 的脱敏值，实际 " + describeValue(flattenText(after))
      );
      check(
        flattenText(after).indexOf(MASKED_KEY) < 0,
        "面板不应再显示旧 Key 的脱敏值，实际 " + describeValue(flattenText(after))
      );
    });

    await runCase("A14 client：凭据读取失败后可重试，成功态可刷新", async () => {
      const env = bootClient();
      env.pushResponse(jsonResponse(200, { ok: true, windows: cloneWindows() }));
      const record = mountClient(env);
      await settleClient(record);

      buttonByLabel(footerOf(record.tree), "设置").props.onClick();
      record.render();

      env.pushResponse(jsonResponse(500, { ok: false, error: "宿主侧未就绪" }));
      buttonByText(panelOf(record.tree), "查看").props.onClick();
      await settleClient(record);

      let panel = panelOf(record.tree);
      check(
        flattenText(panel).indexOf("宿主侧未就绪") >= 0,
        "失败应显示宿主给的原因，实际 " + describeValue(flattenText(panel))
      );
      check(buttonByText(panel, "查看") === null, "失败后不应再显示「查看」");
      const retry = buttonByText(panel, "重试");
      check(retry !== null, "失败后应提供「重试」按钮");

      env.pushResponse(
        jsonResponse(200, {
          ok: true,
          key: SECRET_KEY,
          masked: MASKED_KEY,
          source: "OPENCODE_GO_API_KEY",
          length: SECRET_KEY.length,
        })
      );
      retry.props.onClick();
      await settleClient(record);

      check(env.fetchCalls.length === 3, "重试应再请求一次凭据，实际 " + env.fetchCalls.length);
      panel = panelOf(record.tree);
      check(flattenText(panel).indexOf(MASKED_KEY) >= 0, "重试成功后应显示脱敏 Key");
      check(buttonByText(panel, "刷新") !== null, "成功态应提供「刷新」按钮");
    });

    // ---------- Part B：host 半 ----------
    await runCase("B10 host：导出 name / inject", async () => {
      const mod = await importHostModule();
      check(mod.name === "opencode-go-usage", "name 不符：" + describeValue(mod.name));
      check(
        deepEqual(mod.inject, ["webServer"]),
        "inject 应为 [\"webServer\"]，实际 " + describeValue(mod.inject)
      );
    });

    await runCase("B11 host：apply 注册 prefix 路由并走 ctx.effect", async () => {
      const mod = await importHostModule();
      const host = createHostCtx();
      mod.apply(host.ctx);

      check(host.rec.effectLabels.length === 1, "应调用一次 ctx.effect，实际 " + host.rec.effectLabels.length);
      check(host.rec.routes.length === 1, "应注册一条路由，实际 " + host.rec.routes.length);

      const route = host.rec.routes[0];
      // prefix：一个路由同时承载用量与凭据两个端点。
      check(route.kind === "prefix", "路由 kind 应为 prefix，实际 " + describeValue(route.kind));
      check(route.path === ROUTE_PATH, "路由 path 不符：" + describeValue(route.path));
      check(typeof route.handler === "function", "路由缺少 handler 函数");
      check(
        typeof host.rec.effectLabels[0] === "string" && host.rec.effectLabels[0].indexOf(ROUTE_PATH) >= 0,
        "effect label 应提及路由，实际 " + describeValue(host.rec.effectLabels[0])
      );
      check(
        typeof host.rec.effectDisposers[0] === "function",
        "ctx.effect 回调应返回 register 的 disposer，实际 " + describeValue(host.rec.effectDisposers[0])
      );
    });

    await runCase("B12 host：GET 打上游一次并归一化三个窗口", async () => {
      resetUpstream();
      const mod = await importHostModule();
      const host = createHostCtx();
      mod.apply(host.ctx);
      pushUpstream(200, UPSTREAM_USAGE);

      const res = await callRoute(host.rec.routes[0], { method: "GET" });

      check(upstream.calls.length === 1, "应只打一次上游，实际 " + upstream.calls.length);
      const call = upstream.calls[0];
      check(call.url === UPSTREAM_URL, "上游 URL 不符：" + describeValue(call.url));
      check(call.init.method === "GET", "上游 method 应为 GET，实际 " + describeValue(call.init.method));
      check(
        call.init.headers !== undefined && call.init.headers.authorization === "Bearer test-key",
        "上游 authorization 应为 Bearer test-key，实际 " +
          describeValue(call.init.headers && call.init.headers.authorization)
      );

      check(res.status === 200, "路由应返回 200，实际 " + describeValue(res.status));
      check(
        res.headers !== null && res.headers["content-type"] === "application/json; charset=utf-8",
        "content-type 不符：" + describeValue(res.headers)
      );
      check(
        res.headers !== null && res.headers["cache-control"] === "no-store",
        "cache-control 应为 no-store，实际 " + describeValue(res.headers)
      );

      const body = parseJsonBody(res);
      check(body.ok === true, "响应体 ok 应为 true，实际 " + describeValue(body));
      check(
        Array.isArray(body.windows) && body.windows.length === 3,
        "窗口数应为 3，实际 " + describeValue(body.windows && body.windows.length)
      );
      for (let i = 0; i < HOST_EXPECTED_WINDOWS.length; i += 1) {
        check(
          deepEqual(body.windows[i], HOST_EXPECTED_WINDOWS[i]),
          "windows[" + i + "] 不符：" + describeValue(body.windows[i]) +
            "，期望 " + describeValue(HOST_EXPECTED_WINDOWS[i])
        );
      }
    });

    await runCase("B13 host：上游 401 / 403 映射为可读错误", async () => {
      resetUpstream();

      const mod401 = await importHostModule();
      const host401 = createHostCtx();
      mod401.apply(host401.ctx);
      pushUpstream(401, { error: "unauthorized" });
      const res401 = await callRoute(host401.rec.routes[0], { method: "GET" });
      check(upstream.calls.length === 1, "401 场景应打一次上游，实际 " + upstream.calls.length);
      const body401 = parseJsonBody(res401);
      check(body401.ok === false, "401 应返回 ok:false，实际 " + describeValue(body401));
      check(
        typeof body401.error === "string" && body401.error.indexOf("401") >= 0,
        "401 错误信息应含 401，实际 " + describeValue(body401.error)
      );

      // 403 用新的模块实例，避开 20s 错误缓存。
      const mod403 = await importHostModule();
      const host403 = createHostCtx();
      mod403.apply(host403.ctx);
      pushUpstream(403, { error: "forbidden" });
      const res403 = await callRoute(host403.rec.routes[0], { method: "GET" });
      const body403 = parseJsonBody(res403);
      check(body403.ok === false, "403 应返回 ok:false，实际 " + describeValue(body403));
      check(
        typeof body403.error === "string" && body403.error.indexOf("403") >= 0,
        "403 错误信息应含 403，实际 " + describeValue(body403.error)
      );
    });

    await runCase("B14 host：旧扁平结构归一化为三窗口", async () => {
      resetUpstream();
      const mod = await importHostModule();
      const host = createHostCtx();
      mod.apply(host.ctx);
      pushUpstream(200, {
        rollingUsage: { status: "ok", usagePercent: 7, resetInSec: 600 },
        weeklyUsage: { status: "ok", usagePercent: 3, resetInSec: 3600 },
        monthlyUsage: { status: "ok", usagePercent: 1, resetInSec: 86400 },
      });

      const res = await callRoute(host.rec.routes[0], { method: "GET" });
      check(upstream.calls.length === 1, "应打一次上游，实际 " + upstream.calls.length);

      const body = parseJsonBody(res);
      check(body.ok === true, "ok 应为 true，实际 " + describeValue(body));
      check(
        Array.isArray(body.windows) && body.windows.length === 3,
        "窗口数应为 3，实际 " + describeValue(body.windows && body.windows.length)
      );

      const first = body.windows[0];
      check(
        first.key === "rolling" && first.label === "Rolling usage",
        "首个窗口标识不符：" + describeValue(first)
      );
      check(first.status === "ok", "status 应为 ok，实际 " + describeValue(first.status));
      check(first.percent === 7, "percent 应取 usagePercent=7，实际 " + describeValue(first.percent));
      check(first.remainingPercent === 93, "remainingPercent 应为 93，实际 " + describeValue(first.remainingPercent));

      const resetAt = Date.parse(first.resetsAt);
      const expectedAt = Date.now() + 600 * 1000;
      check(
        Number.isFinite(resetAt) && Math.abs(resetAt - expectedAt) < 5000,
        "resetInSec=600 应换算为约 10 分钟后的时间，实际 " + describeValue(first.resetsAt)
      );
    });

    await runCase("B15 host：percent 为 0 时丢弃 resetsAt", async () => {
      resetUpstream();
      const mod = await importHostModule();
      const host = createHostCtx();
      mod.apply(host.ctx);
      pushUpstream(200, {
        usage: {
          rolling: { status: "ok", percent: 0, resetsAt: "2026-08-13T16:27:38.287Z" },
          weekly: { status: "ok", percent: 3, resetsAt: "2026-08-17T00:00:00.000Z" },
          monthly: { status: "ok", percent: 1, resetsAt: "2026-09-13T06:06:01.287Z" },
        },
      });

      const res = await callRoute(host.rec.routes[0], { method: "GET" });
      const body = parseJsonBody(res);
      check(body.ok === true, "ok 应为 true，实际 " + describeValue(body));
      check(
        Array.isArray(body.windows) && body.windows.length === 3,
        "窗口数应为 3，实际 " + describeValue(body.windows && body.windows.length)
      );
      check(body.windows[0].percent === 0, "percent 应为 0，实际 " + describeValue(body.windows[0].percent));
      check(
        body.windows[0].resetsAt === null,
        "percent=0 时应丢弃 resetsAt（上游只是 now+window 占位值），实际 " +
          describeValue(body.windows[0].resetsAt)
      );
      check(
        body.windows[1].resetsAt === "2026-08-17T00:00:00.000Z",
        "非 0 窗口应保留 resetsAt，实际 " + describeValue(body.windows[1].resetsAt)
      );
    });

    await runCase("B16 host：TTL 内两次 GET 只打一次上游（缓存）", async () => {
      resetUpstream();
      const mod = await importHostModule();
      const host = createHostCtx();
      mod.apply(host.ctx);
      pushUpstream(200, UPSTREAM_USAGE);

      const res1 = await callRoute(host.rec.routes[0], { method: "GET" });
      const res2 = await callRoute(host.rec.routes[0], { method: "GET" });

      check(upstream.calls.length === 1, "TTL 内两次调用应只打一次上游，实际 " + upstream.calls.length);

      const body1 = parseJsonBody(res1);
      const body2 = parseJsonBody(res2);
      check(body1.ok === true, "第一次响应 ok 应为 true，实际 " + describeValue(body1));
      check(body2.ok === true, "第二次响应 ok 应为 true，实际 " + describeValue(body2));
      check(deepEqual(body1.windows, body2.windows), "两次响应的窗口不一致");
      check(
        body1.fetchedAt === body2.fetchedAt,
        "第二次应直接复用缓存体（fetchedAt 应相同），实际 " +
          describeValue(body1.fetchedAt) + " / " + describeValue(body2.fetchedAt)
      );
    });

    await runCase("B17 host：非 GET/HEAD 返回 405 且不打上游", async () => {
      resetUpstream();
      const mod = await importHostModule();
      const host = createHostCtx();
      mod.apply(host.ctx);

      const res = await callRoute(host.rec.routes[0], { method: "POST" });
      check(res.status === 405, "POST 应返回 405，实际 " + describeValue(res.status));
      check(
        res.headers !== null && res.headers.allow === "GET, HEAD",
        "405 应声明 allow: GET, HEAD，实际 " + describeValue(res.headers)
      );
      check(res.body === undefined, "405 不应有响应体，实际 " + describeValue(res.body));
      check(upstream.calls.length === 0, "405 不应请求上游，实际 " + upstream.calls.length);
    });

    await runCase("B18 host：/key 子路由返回明文、脱敏与来源；未知子路径 404", async () => {
      const mod = await importHostModule();
      const host = createHostCtx();
      mod.apply(host.ctx);

      // 短 key：脱敏走「前 2 + …」分支。
      const shortRes = await callRoute(host.rec.routes[0], { method: "GET", url: ROUTE_PATH + "/key" });
      const shortBody = parseJsonBody(shortRes);
      check(shortBody.ok === true, "凭据端点应成功，实际 " + describeValue(shortBody));
      check(shortBody.key === "test-key", "应返回明文，实际 " + describeValue(shortBody.key));
      check(shortBody.masked === "te\u2026", "短 Key 脱敏应为 te…，实际 " + describeValue(shortBody.masked));
      check(shortBody.source === "OPENCODE_GO_API_KEY", "来源不符：" + describeValue(shortBody.source));
      check(shortBody.length === 8, "长度不符：" + describeValue(shortBody.length));

      // 长 key：脱敏走「前 6 + … + 后 4」分支。
      process.env.OPENCODE_GO_API_KEY = SECRET_KEY;
      const longRes = await callRoute(host.rec.routes[0], { method: "GET", url: ROUTE_PATH + "/key" });
      const longBody = parseJsonBody(longRes);
      check(longBody.key === SECRET_KEY, "应返回长 Key 明文");
      check(
        longBody.masked === MASKED_KEY,
        "长 Key 脱敏应为 " + describeValue(MASKED_KEY) + "，实际 " + describeValue(longBody.masked)
      );
      check(longBody.masked !== longBody.key, "脱敏不应等于明文");

      // prefix 路由下的未知子路径。
      const missing = await callRoute(host.rec.routes[0], { method: "GET", url: ROUTE_PATH + "/nope" });
      check(missing.status === 404, "未知子路径应 404，实际 " + describeValue(missing.status));
    });

    await runCase("B19 host：DSH 凭据（ctx.credentials）优先，换 Key 后无需重启自动生效", async () => {
      resetUpstream();
      delete process.env.OPENCODE_GO_API_KEY;
      delete process.env.OPENCODE_API_KEY;
      delete process.env.OPENCODE_AUTH_CONTENT;

      const firstKey = "sk-dshkey000000000000000000000000000001";
      const secondKey = "sk-dshkey000000000000000000000000000002";
      const maskOf = (key) => key.slice(0, 6) + "\u2026" + key.slice(-4);

      let current = { value: firstKey, source: "file" };
      const mod = await importHostModule();
      const host = createHostCtx({
        credentials: function (rec) {
          return {
            resolve: function resolve(ref) {
              rec.credentialRefs.push(ref);
              return Promise.resolve(current);
            },
          };
        },
      });
      mod.apply(host.ctx);

      // TTL 过期靠推进 Date.now 模拟，不必真等 30 秒。
      const realNow = Date.now;
      let skew = 0;
      Date.now = function now() {
        return realNow() + skew;
      };
      try {
        pushUpstream(200, UPSTREAM_USAGE);
        const body1 = parseJsonBody(await callRoute(host.rec.routes[0], { method: "GET" }));
        check(body1.ok === true, "应取到用量，实际 " + describeValue(body1));
        check(
          upstream.calls[upstream.calls.length - 1].init.headers.authorization === "Bearer " + firstKey,
          "上游应收到 DSH 凭据里的 Key，实际 " +
            describeValue(upstream.calls[upstream.calls.length - 1].init.headers.authorization)
        );
        check(
          host.rec.credentialRefs[0] === "OPENCODE_GO_API_KEY",
          "应 resolve OPENCODE_GO_API_KEY，实际 " + describeValue(host.rec.credentialRefs[0])
        );
        check(
          typeof body1.keySource === "string" && body1.keySource.indexOf("DSH 凭据") >= 0,
          "keySource 应标明 DSH 凭据，实际 " + describeValue(body1.keySource)
        );
        check(
          body1.keyMasked === maskOf(firstKey),
          "keyMasked 应供页面比对，期望 " + describeValue(maskOf(firstKey)) + "，实际 " + describeValue(body1.keyMasked)
        );

        // 在 DSH 设置页换 Key → 托管文档变了，下一次刷新必须用新值。
        current = { value: secondKey, source: "file" };
        skew = 31 * 1000;
        pushUpstream(200, UPSTREAM_USAGE);
        await callRoute(host.rec.routes[0], { method: "GET" });
        check(upstream.calls.length === 2, "缓存过期后应重新打上游，实际 " + upstream.calls.length);
        check(
          upstream.calls[upstream.calls.length - 1].init.headers.authorization === "Bearer " + secondKey,
          "换 Key 后上游应用新值，实际 " +
            describeValue(upstream.calls[upstream.calls.length - 1].init.headers.authorization)
        );

        const keyBody = parseJsonBody(await callRoute(host.rec.routes[0], { method: "GET", url: ROUTE_PATH + "/key" }));
        check(keyBody.ok === true && keyBody.key === secondKey, "凭据端点也应立即反映新 Key，实际 " + describeValue(keyBody));
      } finally {
        Date.now = realNow;
      }
    });

    await runCase("B20 host：没有 credentials 服务时回落到 auth.json（不崩）", async () => {
      resetUpstream();
      delete process.env.OPENCODE_GO_API_KEY;
      delete process.env.OPENCODE_API_KEY;
      delete process.env.OPENCODE_AUTH_CONTENT;

      const fileKey = "sk-fromauthfile0000000000000000000007";
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ogu-verify-"));
      const authFile = path.join(dir, "opencode", "auth.json");
      fs.mkdirSync(path.dirname(authFile), { recursive: true });
      fs.writeFileSync(authFile, JSON.stringify({ "opencode-go": { type: "api", key: fileKey } }));

      const savedXdg = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = dir;
      try {
        // 老式 ctx：完全没有 get()，等价于组合里没有 credentials-local。
        const routes = [];
        const mod = await importHostModule();
        mod.apply({
          effect: function effect(fn) {
            return fn();
          },
          webServer: {
            register: function register(route) {
              routes.push(route);
              return function disposeRoute() {};
            },
          },
        });

        pushUpstream(200, UPSTREAM_USAGE);
        const body = parseJsonBody(await callRoute(routes[0], { method: "GET" }));
        check(body.ok === true, "缺 credentials 服务时仍应取到用量，实际 " + describeValue(body));
        check(
          upstream.calls[upstream.calls.length - 1].init.headers.authorization === "Bearer " + fileKey,
          "应回落到 auth.json 里的 Key，实际 " +
            describeValue(upstream.calls[upstream.calls.length - 1].init.headers.authorization)
        );
        check(
          body.keySource === authFile,
          "keySource 应为 auth.json 路径，期望 " + describeValue(authFile) + "，实际 " + describeValue(body.keySource)
        );
      } finally {
        restoreEnv("XDG_DATA_HOME", savedXdg);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  } finally {
    restoreEnv("OPENCODE_GO_API_KEY", savedEnv.OPENCODE_GO_API_KEY);
    restoreEnv("OPENCODE_API_KEY", savedEnv.OPENCODE_API_KEY);
    restoreEnv("OPENCODE_AUTH_CONTENT", savedEnv.OPENCODE_AUTH_CONTENT);

    if (failed === 0) {
      console.log("\n全部用例通过 \u2713（" + passed + "/" + total + "）");
    } else {
      console.log("\n存在失败用例：" + failed + "/" + total + " 失败");
    }
  }
})().catch(function crash(error) {
  console.error("FAIL  验证脚本崩溃: " + (error && error.stack ? error.stack : String(error)));
  process.exitCode = 1;
});
