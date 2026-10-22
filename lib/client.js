/**
 * dsh-opencode-go-usage —— browser (client) half.
 *
 * 在 `shell.overlay`（帧级浮层：位于所有列之上、滚动容器之外，root scope，
 * 因此无会话时同样存在）注册一个常驻浮窗。每 60 秒（可改）向宿主侧同源路由
 * `/opencode-go-usage` 拉取一次 opencode Go 套餐用量，卡片内三行垂直排列：
 *
 *   Rolling usage  [9%]              Resets in 3h 8m
 *   ██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
 *   …
 *                         [设置]
 *
 * 交互：
 *   - 卡片可拖动，位置存 localStorage（`dsh.opencodeGoUsage.pos`），并钳在视口内；
 *   - 「设置」展开面板：查询间隔（30s/1m/2m/5m/10m，存 `…intervalMs`）；
 *   - 面板内可查看 API Key（脱敏 → 显示明文 → 复制 / 刷新）。宿主换过 Key 时
 *     （用量响应里的 `keyMasked` 变了）会自动重取一次，面板不会停在旧 Key 上。
 *   - 凭据读取失败时给「重试」，不必刷新页面。
 *
 * 颜色全部取自 DSH 主题 token（绿色用 state-success 三档），明细主题自适应。
 * 只依赖平台 seed 模块 `react`。
 */
window.__ModuleLoader__.load({
  id: "dsh-opencode-go-usage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    /** 用量路由。 */
    var ROUTE = "/opencode-go-usage";
    /** 凭据路由（同源，仅「查看 Key」时请求）。 */
    var KEY_ROUTE = ROUTE + "/key";
    /** 默认轮询间隔。 */
    var DEFAULT_INTERVAL_MS = 60 * 1000;
    /** 可选轮询间隔。 */
    var INTERVAL_OPTIONS = [
      { ms: 30 * 1000, label: "30s" },
      { ms: 60 * 1000, label: "1m" },
      { ms: 2 * 60 * 1000, label: "2m" },
      { ms: 5 * 60 * 1000, label: "5m" },
      { ms: 10 * 60 * 1000, label: "10m" },
    ];
    /** 请求超时。 */
    var TIMEOUT_MS = 20 * 1000;
    /** 位置持久化键。 */
    var STORAGE_POS = "dsh.opencodeGoUsage.pos";
    /** 间隔持久化键。 */
    var STORAGE_INTERVAL = "dsh.opencodeGoUsage.intervalMs";
    /** 判定为拖动所需的位移（px），小于它算点击。 */
    var DRAG_THRESHOLD = 4;
    /** 贴边留白（px）。 */
    var EDGE = 8;

    // ===== 样式（全部走 DSH 主题 token） =====
    /** 浮窗本体：常驻卡片。 */
    var CARD_STYLE = {
      position: "absolute",
      right: "20px",
      bottom: "20px",
      boxSizing: "border-box",
      minWidth: "320px",
      padding: "4px 14px",
      border: "1px solid var(--dsw-alias-border-l1)",
      borderRadius: "12px",
      background: "var(--dsw-specific-menu)",
      boxShadow: "var(--dsw-shadow-lv3)",
      fontSize: "12px",
      lineHeight: "18px",
      color: "var(--dsw-alias-label-primary)",
      fontVariantNumeric: "tabular-nums",
      userSelect: "none",
      cursor: "grab",
    };
    /** 单行区块（标签行 + 进度条）。 */
    var BLOCK_STYLE = { padding: "10px 0" };
    /** 非首行加发丝分隔线。 */
    var BLOCK_SEPARATED_STYLE = Object.assign({}, BLOCK_STYLE, {
      borderTop: "1px solid var(--dsw-alias-border-l2)",
    });
    /** 标签行：标签 + 徽章在左，倒计时右对齐。 */
    var HEAD_STYLE = { display: "flex", alignItems: "center", gap: "8px" };
    /** 倒计时：推到最右并弱化。 */
    var RESET_STYLE = {
      marginLeft: "auto",
      color: "var(--dsw-alias-label-tertiary)",
      whiteSpace: "nowrap",
    };
    /** 百分比徽章。 */
    var BADGE_STYLE = {
      padding: "0 6px",
      borderRadius: "6px",
      border: "1px solid var(--dsw-alias-state-success-secondary)",
      background: "var(--dsw-alias-state-success-tertiary)",
      color: "var(--dsw-alias-state-success-primary)",
      fontVariantNumeric: "tabular-nums",
    };
    /** 打满时徽章转 error 语义色。 */
    var BADGE_FULL_STYLE = Object.assign({}, BADGE_STYLE, {
      border: "1px solid var(--dsw-alias-state-error-primary)",
      background: "transparent",
      color: "var(--dsw-alias-state-error-primary)",
    });
    /** 进度条轨道。 */
    var TRACK_STYLE = {
      marginTop: "8px",
      height: "8px",
      borderRadius: "999px",
      background: "var(--dsw-alias-interactive-bg-hover)",
      overflow: "hidden",
    };
    /** 进度条填充。 */
    var FILL_STYLE = {
      height: "100%",
      borderRadius: "999px",
      background: "var(--dsw-alias-state-success-primary)",
      transition: "width 0.3s ease",
    };
    /** 打满时填充转 error 色。 */
    var FILL_FULL_STYLE = Object.assign({}, FILL_STYLE, {
      background: "var(--dsw-alias-state-error-primary)",
    });
    /** 弱化文字。 */
    var MUTED_STYLE = { color: "var(--dsw-alias-label-tertiary)" };

    /** 底部操作行。 */
    var FOOTER_STYLE = {
      display: "flex",
      justifyContent: "flex-end",
      padding: "6px 0 8px",
      borderTop: "1px solid var(--dsw-alias-border-l2)",
    };
    /** 小按钮（查看 / 复制 / 间隔 chip）；底色与 hover 由注入的 .dsh-ogu-mini 负责。 */
    var MINI_BUTTON_STYLE = {
      font: "inherit",
      padding: "1px 8px",
      borderRadius: "6px",
      border: "1px solid var(--dsw-alias-border-l2)",
      color: "var(--dsw-alias-label-secondary)",
      cursor: "pointer",
      whiteSpace: "nowrap",
    };
    /** 齿轮按钮（底栏设置入口）：24px 圆形，配色与 hover 交给 .dsh-ogu-icon。 */
    var ICON_BUTTON_STYLE = {
      display: "grid",
      placeItems: "center",
      flex: "none",
      width: "24px",
      height: "24px",
      padding: "0",
      border: "none",
      borderRadius: "999px",
      cursor: "pointer",
    };
    /** 设置面板：垂直堆叠。 */
    var PANEL_STYLE = {
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      padding: "10px 0 12px",
      borderTop: "1px solid var(--dsw-alias-border-l2)",
      cursor: "default",
    };
    /** 面板字段标签。 */
    var PANEL_LABEL_STYLE = { color: "var(--dsw-alias-label-tertiary)" };
    /** 间隔 chip 行。 */
    var CHIPS_STYLE = { display: "flex", gap: "6px", flexWrap: "wrap" };
    /** 未选中 chip。 */
    var CHIP_STYLE = Object.assign({}, MINI_BUTTON_STYLE, {
      color: "var(--dsw-alias-label-secondary)",
    });
    /** 选中 chip。 */
    var CHIP_ACTIVE_STYLE = Object.assign({}, MINI_BUTTON_STYLE, {
      background: "var(--dsw-alias-interactive-bg-active)",
      border: "1px solid var(--dsw-alias-label-secondary)",
      color: "var(--dsw-alias-label-primary)",
      fontWeight: "500",
    });
    /** Key 行：等宽值 + 按钮。 */
    var KEY_ROW_STYLE = { display: "flex", alignItems: "center", gap: "6px" };
    /** Key 值：等宽、可选中、溢出省略。 */
    var KEY_VALUE_STYLE = {
      flex: "1",
      minWidth: "0",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      color: "var(--dsw-alias-label-primary)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      userSelect: "text",
    };
    /** 来源小字。 */
    var SOURCE_STYLE = {
      color: "var(--dsw-alias-label-tertiary)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      userSelect: "text",
    };

    // ===== 需要状态样式的部分 =====
    // :hover / [data-active] 这类状态样式 inline style 表达不了，故注入一张样式表；
    // 模块系统在插件物化时会认领未标记的 <style>，卸载时随之移除。
    /** 注入的样式表 id。 */
    var STYLE_ID = "dsh-opencode-go-usage-style";
    var STYLE_TEXT = [
      ".dsh-ogu-icon{background:transparent;color:var(--dsw-alias-label-tertiary);transition:background .12s ease,color .12s ease;}",
      ".dsh-ogu-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
      ".dsh-ogu-icon[data-active='1']{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);}",
      ".dsh-ogu-mini{background:transparent;transition:background .12s ease,color .12s ease;}",
      ".dsh-ogu-mini:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
      "[data-dragging='1']{cursor:grabbing;}",
    ].join("");

    /** 确保样式表已注入（幂等）。 */
    function ensureStyle() {
      if (typeof document === "undefined" || !document.head) return;
      if (typeof document.getElementById === "function" && document.getElementById(STYLE_ID) !== null) return;
      var el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = STYLE_TEXT;
      document.head.appendChild(el);
    }

    // ===== 持久化 =====
    function readStorage(key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    }

    function writeStorage(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (e) {}
    }

    function readStoredInterval() {
      var raw = parseInt(readStorage(STORAGE_INTERVAL), 10);
      for (var i = 0; i < INTERVAL_OPTIONS.length; i++) {
        if (INTERVAL_OPTIONS[i].ms === raw) return raw;
      }
      return DEFAULT_INTERVAL_MS;
    }

    function readStoredPos() {
      try {
        var parsed = JSON.parse(readStorage(STORAGE_POS));
        if (parsed && typeof parsed.x === "number" && typeof parsed.y === "number") {
          return { x: parsed.x, y: parsed.y };
        }
      } catch (e) {}
      return null;
    }

    // ===== 统一 store =====
    var store = {
      // 用量
      phase: "loading",
      windows: null,
      error: null,
      fetchedAt: null,
      // 设置
      intervalMs: readStoredInterval(),
      pos: readStoredPos(),
      open: false,
      // 凭据
      keyPhase: "idle",
      keyInfo: null,
      keyError: null,
      revealed: false,
      copied: false,
    };
    var listeners = new Set();
    var pollTimer = null;
    var usageInflight = null;
    var keyInflight = null;
    var copyTimer = null;
    var mounted = 0;

    function setStore(patch) {
      store = Object.assign({}, store, patch);
      listeners.forEach(function (fn) {
        try {
          fn();
        } catch (e) {}
      });
    }

    function subscribe(fn) {
      listeners.add(fn);
      return function () {
        listeners.delete(fn);
      };
    }

    function getSnapshot() {
      return store;
    }

    // ===== 取数 =====
    function requestJson(url) {
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      var timeoutId =
        controller === null
          ? null
          : window.setTimeout(function () {
              controller.abort();
            }, TIMEOUT_MS);

      return Promise.resolve()
        .then(function () {
          return window.fetch(url, {
            method: "GET",
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: controller === null ? undefined : controller.signal,
          });
        })
        .then(function (res) {
          return res.json().then(
            function (body) {
              return { ok: res.ok, status: res.status, body: body };
            },
            function () {
              return { ok: res.ok, status: res.status, body: null };
            }
          );
        })
        .then(function (res) {
          if (timeoutId !== null) window.clearTimeout(timeoutId);
          if (!res.body || res.body.ok !== true) {
            throw new Error(String((res.body && res.body.error) || "HTTP " + String(res.status)));
          }
          return res.body;
        })
        .catch(function (err) {
          if (timeoutId !== null) window.clearTimeout(timeoutId);
          var message = (err && err.message) || String(err);
          if (err && err.name === "AbortError") message = "请求超时";
          throw new Error(message);
        });
    }

    function loadUsage() {
      if (usageInflight !== null) return usageInflight;
      usageInflight = requestJson(ROUTE)
        .then(function (body) {
          setStore({
            phase: "ready",
            windows: Array.isArray(body.windows) ? body.windows : [],
            error: null,
            fetchedAt: Date.now(),
          });
          // 宿主侧的 Key 变了（例如在 DSH 设置页换了 Key）：面板里已加载的凭据
          // 快照跟着重取一次，免得「显示 / 复制」还给出旧 Key。未查看过则不打扰。
          var info = store.keyInfo;
          var masked = typeof body.keyMasked === "string" ? body.keyMasked : null;
          if (
            store.keyPhase === "ready" &&
            info !== null &&
            masked !== null &&
            masked !== String(info.masked || "")
          ) {
            loadKey();
          }
        })
        .catch(function (err) {
          // 已成功过一次就保留旧读数，只把错误挂到 tooltip，避免卡片闪成错误态。
          setStore({ phase: store.windows === null ? "error" : "ready", error: err.message });
        })
        .then(function () {
          usageInflight = null;
        });
      return usageInflight;
    }

    function loadKey() {
      if (keyInflight !== null) return keyInflight;
      setStore({ keyPhase: "loading", keyError: null });
      keyInflight = requestJson(KEY_ROUTE)
        .then(function (body) {
          setStore({ keyPhase: "ready", keyInfo: body, keyError: null });
        })
        .catch(function (err) {
          setStore({ keyPhase: "error", keyInfo: null, keyError: err.message });
        })
        .then(function () {
          keyInflight = null;
        });
      return keyInflight;
    }

    // ===== 轮询 =====
    /** 按当前间隔（重）启动轮询；未挂载时不做任何事。 */
    function restartPolling() {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      if (mounted <= 0) return;
      loadUsage();
      pollTimer = window.setInterval(loadUsage, store.intervalMs);
    }

    function stopPolling() {
      if (pollTimer === null) return;
      window.clearInterval(pollTimer);
      pollTimer = null;
    }

    // ===== 拖动 =====
    /** 把坐标钳进视口（留 EDGE 边距）。 */
    function clampPos(x, y, width, height) {
      var vw = window.innerWidth || 1200;
      var vh = window.innerHeight || 800;
      var maxX = Math.max(EDGE, vw - (width || 320) - EDGE);
      var maxY = Math.max(EDGE, vh - (height || 160) - EDGE);
      return {
        x: Math.max(EDGE, Math.min(x, maxX)),
        y: Math.max(EDGE, Math.min(y, maxY)),
      };
    }

    /** 面板内的元素不参与拖动。 */
    function inNoDrag(node) {
      var cur = node;
      while (cur !== null && cur !== undefined) {
        if (typeof cur.getAttribute === "function" && cur.getAttribute("data-no-drag") !== null) {
          return true;
        }
        cur = cur.parentNode;
      }
      return false;
    }

    /** 从拖动距离推导卡片定位：拖动后改用 left/top。 */
    function cardStyle() {
      var style = Object.assign({}, CARD_STYLE);
      if (store.pos !== null) {
        style.left = store.pos.x + "px";
        style.top = store.pos.y + "px";
        style.right = "auto";
        style.bottom = "auto";
      }
      return style;
    }

    /**
     * 卡片拖动：以下是位移阈值判定（超过才算是拖动，否则当成点击）。
     * @param e - pointerdown 事件。
     */
    function onCardPointerDown(e) {
      if (e && typeof e.button === "number" && e.button !== 0) return;
      if (inNoDrag(e && e.target)) return;
      var el = e && e.currentTarget;
      if (!el || typeof el.getBoundingClientRect !== "function") return;

      var rect = el.getBoundingClientRect();
      var startX = e.clientX;
      var startY = e.clientY;
      var originLeft = rect.left;
      var originTop = rect.top;
      var moved = false;

      function onMove(ev) {
        var dx = ev.clientX - startX;
        var dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) <= DRAG_THRESHOLD) return;
        moved = true;
        if (typeof el.setAttribute === "function") el.setAttribute("data-dragging", "1");
        var next = clampPos(originLeft + dx, originTop + dy, rect.width, rect.height);
        el.style.left = next.x + "px";
        el.style.top = next.y + "px";
        el.style.right = "auto";
        el.style.bottom = "auto";
        if (typeof ev.preventDefault === "function") ev.preventDefault();
      }

      function onEnd() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
        if (typeof el.removeAttribute === "function") el.removeAttribute("data-dragging");
        if (!moved) return;
        var settled = el.getBoundingClientRect();
        var pos = { x: settled.left, y: settled.top };
        setStore({ pos: pos });
        writeStorage(STORAGE_POS, JSON.stringify(pos));
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
    }

    // ===== 剪贴板 =====
    function fallbackCopy(text) {
      try {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        var ok = typeof document.execCommand === "function" ? document.execCommand("copy") : false;
        document.body.removeChild(area);
        return !!ok;
      } catch (e) {
        return false;
      }
    }

    function copyText(text) {
      var nav = window.navigator;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
        return nav.clipboard.writeText(text).then(
          function () {
            return true;
          },
          function () {
            return fallbackCopy(text);
          }
        );
      }
      return Promise.resolve(fallbackCopy(text));
    }

    function markCopied() {
      if (copyTimer !== null) window.clearTimeout(copyTimer);
      setStore({ copied: true });
      copyTimer = window.setTimeout(function () {
        copyTimer = null;
        setStore({ copied: false });
      }, 2000);
    }

    // ===== 格式化 =====
    function toNumber(value) {
      if (typeof value !== "number" || !isFinite(value)) return null;
      return Math.round(value * 10) / 10;
    }

    function percentText(value) {
      var n = toNumber(value);
      return n === null ? "—" : String(n) + "%";
    }

    function fillWidth(value) {
      var n = toNumber(value);
      if (n === null) return "0%";
      return String(Math.max(0, Math.min(100, n))) + "%";
    }

    /**
     * 重置倒计时，形如 "Resets in 3h 17m" / "Resets in 4d 20h"。
     * 不足 1 天显示「时+分」，超过 1 天显示「天+时」。
     * @param iso - ISO-8601 重置时间；null 表示未知（percent 为 0 时上游只给占位值）。
     * @returns 倒计时文本，或 null。
     */
    function resetText(iso) {
      if (typeof iso !== "string" || iso === "") return null;
      var date = new Date(iso);
      if (isNaN(date.getTime())) return null;
      var totalMinutes = Math.round((date.getTime() - Date.now()) / 60000);
      if (totalMinutes <= 0) return "Resetting…";
      var days = Math.floor(totalMinutes / 1440);
      var hours = Math.floor((totalMinutes % 1440) / 60);
      var minutes = totalMinutes % 60;
      if (days > 0) return "Resets in " + days + "d " + hours + "h";
      if (hours > 0) return "Resets in " + hours + "h " + minutes + "m";
      return "Resets in " + minutes + "m";
    }

    function isExhausted(w) {
      return !!w && (w.status === "rate-limited" || (typeof w.percent === "number" && w.percent >= 100));
    }

    function tooltipOf(windows, error) {
      var lines = windows.map(function (w) {
        return w.label + "：剩余 " + percentText(w.remainingPercent);
      });
      lines.push("可拖动调整位置；点「设置」修改查询间隔或查看 API Key。");
      if (error) lines.push("上次刷新失败：" + error);
      return lines.join("\n");
    }

    // ===== 组件 =====
    /** 齿轮轮廓（outline 风格，与 DSH 的 16px 图标族一致）。 */
    var GEAR_PATH =
      "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z";

    /**
     * 渲染齿轮图标。
     * @returns 图标元素。
     */
    function gearIcon() {
      return React.createElement(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: 14,
          height: 14,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.8,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        React.createElement("path", { key: "gear", d: GEAR_PATH }),
        React.createElement("circle", { key: "hub", cx: 12, cy: 12, r: 3 })
      );
    }

    /** 三行用量区块。 */
    function usageBlocks(windows) {
      return windows.map(function (w, i) {
        var full = isExhausted(w);
        var countdown = resetText(w.resetsAt);
        return React.createElement(
          "div",
          { key: w.key, "data-block": w.key, style: i === 0 ? BLOCK_STYLE : BLOCK_SEPARATED_STYLE },
          React.createElement(
            "div",
            { style: HEAD_STYLE },
            React.createElement("span", null, w.label),
            React.createElement(
              "span",
              { style: full ? BADGE_FULL_STYLE : BADGE_STYLE },
              percentText(w.percent)
            ),
            countdown === null
              ? null
              : React.createElement("span", { style: RESET_STYLE }, countdown)
          ),
          React.createElement(
            "div",
            { style: TRACK_STYLE },
            React.createElement("div", {
              style: Object.assign({}, full ? FILL_FULL_STYLE : FILL_STYLE, {
                width: fillWidth(w.percent),
              }),
            })
          )
        );
      });
    }

    /** 间隔选择行。 */
    function intervalRow() {
      var chips = INTERVAL_OPTIONS.map(function (opt) {
        return React.createElement(
          "button",
          {
            key: String(opt.ms),
            type: "button",
            className: "dsh-ogu-mini",
            style: opt.ms === store.intervalMs ? CHIP_ACTIVE_STYLE : CHIP_STYLE,
            onClick: function () {
              if (opt.ms === store.intervalMs) return;
              setStore({ intervalMs: opt.ms });
              writeStorage(STORAGE_INTERVAL, String(opt.ms));
              restartPolling();
            },
          },
          opt.label
        );
      });
      return React.createElement(
        "div",
        null,
        React.createElement("div", { style: PANEL_LABEL_STYLE }, "查询间隔"),
        React.createElement("div", { style: CHIPS_STYLE }, chips)
      );
    }

    /** API Key 行：脱敏 → 明文，外加复制。 */
    function keyRow() {
      var children = [React.createElement("div", { key: "label", style: PANEL_LABEL_STYLE }, "API Key")];

      if (store.keyPhase === "idle") {
        children.push(
          React.createElement(
            "div",
            { key: "row", style: KEY_ROW_STYLE },
            React.createElement("span", { style: MUTED_STYLE }, "••••••••"),
            React.createElement(
              "button",
              { type: "button", className: "dsh-ogu-mini", style: MINI_BUTTON_STYLE, onClick: function () { loadKey(); } },
              "查看"
            )
          )
        );
      } else if (store.keyPhase === "loading") {
        children.push(React.createElement("div", { key: "row", style: MUTED_STYLE }, "加载中…"));
      } else if (store.keyPhase === "error") {
        children.push(
          React.createElement(
            "div",
            { key: "row", style: KEY_ROW_STYLE },
            React.createElement("span", { style: MUTED_STYLE }, store.keyError || "读取失败"),
            React.createElement(
              "button",
              {
                type: "button",
                className: "dsh-ogu-mini",
                style: MINI_BUTTON_STYLE,
                onClick: function () { loadKey(); },
              },
              "重试"
            )
          )
        );
      } else {
        var info = store.keyInfo || {};
        children.push(
          React.createElement(
            "div",
            { key: "row", style: KEY_ROW_STYLE },
            React.createElement(
              "span",
              { style: KEY_VALUE_STYLE, title: store.revealed ? String(info.key || "") : "" },
              store.revealed ? String(info.key || "") : String(info.masked || "")
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "dsh-ogu-mini",
                style: MINI_BUTTON_STYLE,
                onClick: function () { setStore({ revealed: !store.revealed }); },
              },
              store.revealed ? "隐藏" : "显示"
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "dsh-ogu-mini",
                style: MINI_BUTTON_STYLE,
                onClick: function () {
                  copyText(String(info.key || "")).then(function (ok) {
                    if (ok) markCopied();
                  });
                },
              },
              store.copied ? "已复制" : "复制"
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "dsh-ogu-mini",
                style: MINI_BUTTON_STYLE,
                onClick: function () { loadKey(); },
              },
              "刷新"
            )
          )
        );
        children.push(
          React.createElement(
            "div",
            { key: "source", style: SOURCE_STYLE, title: String(info.source || "") },
            "来源：" + String(info.source || "未知")
          )
        );
      }

      return React.createElement("div", null, children);
    }

    /** 设置面板。 */
    function settingsPanel() {
      if (!store.open) return null;
      return React.createElement(
        "div",
        { style: PANEL_STYLE, "data-no-drag": "1" },
        intervalRow(),
        keyRow()
      );
    }

    /**
     * 用量浮窗。用量是账号级数据，与具体会话无关，故忽略座席传入的 props。
     */
    function OpenCodeGoUsageCard() {
      var snap = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

      React.useEffect(function () {
        mounted += 1;
        restartPolling();
        // 视口变小时把卡片拉回可视范围。
        function onResize() {
          if (store.pos === null) return;
          var next = clampPos(store.pos.x, store.pos.y, 320, 160);
          if (next.x !== store.pos.x || next.y !== store.pos.y) {
            setStore({ pos: next });
            writeStorage(STORAGE_POS, JSON.stringify(next));
          }
        }
        window.addEventListener("resize", onResize);
        return function () {
          mounted -= 1;
          window.removeEventListener("resize", onResize);
          if (mounted <= 0) stopPolling();
        };
      }, []);

      var windows = snap.windows;

      // 首次尚未拿到数据：不占屏，避免一闪而过的空卡片。
      if (!windows || windows.length === 0) {
        if (snap.phase === "error") {
          return React.createElement(
            "div",
            { style: cardStyle(), title: snap.error || "" },
            React.createElement("span", { style: MUTED_STYLE }, "opencode Go usage 不可用")
          );
        }
        return null;
      }

      return React.createElement(
        "div",
        {
          style: cardStyle(),
          title: tooltipOf(windows, snap.error),
          onPointerDown: onCardPointerDown,
        },
        usageBlocks(windows),
        React.createElement(
          "div",
          { style: FOOTER_STYLE, "data-footer": "1" },
          React.createElement(
            "button",
            {
              type: "button",
              className: "dsh-ogu-icon",
              style: ICON_BUTTON_STYLE,
              "aria-label": "设置",
              "aria-expanded": snap.open ? "true" : "false",
              "data-active": snap.open ? "1" : "0",
              title: "设置",
              onClick: function () { setStore({ open: !store.open }); },
            },
            gearIcon()
          )
        ),
        settingsPanel()
      );
    }

    // ===== 插件形态 =====
    // 状态样式（hover / 拖动光标）随 bundle 物化注入一次。
    ensureStyle();

    /** cordis 插件名。 */
    exports.name = "opencode-go-usage";
    /** 依赖座席服务；声明后 apply 会等到 slots 就绪。 */
    exports.inject = ["slots"];

    /**
     * 客户端插件体：把用量浮窗注册进帧级浮层 `shell.overlay`。
     * @param ctx - 客户端插件上下文。
     */
    exports.apply = function apply(ctx) {
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          {
            name: "shell.overlay",
            id: "opencode-go-usage",
            order: 100,
            label: "opencode Go usage",
          },
          OpenCodeGoUsageCard
        );
      });
    };

    return module.exports;
  },
});
