#!/usr/bin/env node
/*
 * codex-statusbar.mjs —— 把 zcode-statusbar 风格的底部数据统计条注入 OpenAI Codex 桌面 app
 *
 * 移植自 zcode-statusbar（ZCode 版，https://github.com/xyqmbyl/zcode-statusbar），
 * 逻辑与排版保持一致，数据源换成 Codex：
 *   · app 侧：微软商店版 Codex 桌面 app（MSIX 包 OpenAI.Codex_2p2nqsd0c76g0，Electron，
 *     主进程 ChatGPT.exe，主窗口 CDP 目标 app://-/index.html）。调试端口 9224
 *     （9222 被 ZCode 占用、9223 被 Edge 占用），带端口启动/修复由 codex-bg 的
 *     ensure-codex-debug.ps1 + codex-bg-watchdog.mjs 负责，本工具只管连接与注入。
 *   · 指标侧：不读页面 DOM，而是读 Codex 自己落盘的数据——
 *       state_5.sqlite 的 threads 表（recency_at_ms 认出屏幕上的会话、rollout_path、标题、模型）；
 *       thread_history_1.sqlite 的 thread_turns 表（每轮 status / duration_ms）；
 *       ~/.codex/sessions/.../rollout-*.jsonl（token_usage_record 每次模型调用的真实
 *       usage：input_tokens 已含缓存；task_started/task_complete 认轮次；token_count
 *       事件带累计 total_token_usage 与 model_context_window）。
 *     rollout 按 offset 增量读：watch 期间每拍只解析新追加的字节，换会话才整扫一次。
 *
 * 用法：
 *   node codex-statusbar.mjs               # 连接 Codex 并注入（常驻，无窗口）
 *   node codex-statusbar.mjs --print       # 只打印当前指标，不注入（自检）
 *   node codex-statusbar.mjs --stop        # 停止常驻的注入器
 *   node codex-statusbar.mjs --port 9224 --interval 1200
 *
 * 依赖：Node >= 22（用到 node:sqlite 与全局 WebSocket），无第三方包。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// node:sqlite 仍会发 ExperimentalWarning，这里只压掉这一条
process.on("warning", (w) => {
  if (w && w.name === "ExperimentalWarning" && /SQLite/i.test(String(w.message))) return;
  process.emitWarning ? console.warn(w.name + ": " + w.message) : null;
});

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch (e) {
  console.error("需要 Node 22+ 才能使用内置 node:sqlite。当前版本：" + process.version);
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODEX_HOME = process.env.CXSB_CODEX_HOME || path.join(os.homedir(), ".codex");
const DB_PATH = process.env.CXSB_DB || path.join(CODEX_HOME, "state_5.sqlite");
const TURNS_DB_PATH = process.env.CXSB_TURNS_DB || path.join(CODEX_HOME, "thread_history_1.sqlite");

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
function argOf(name, dflt) {
  const hit = argv.find((a) => a === name || a.startsWith(name + "="));
  if (!hit) return dflt;
  if (hit.includes("=")) return hit.split("=").slice(1).join("=");
  const i = argv.indexOf(hit);
  return argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
}
const OPTS = {
  port: Number(argOf("--port", process.env.CXSB_PORT || 9224)),
  interval: Number(argOf("--interval", process.env.CXSB_INTERVAL || 1200)),
  print: !!argOf("--print", false),
  quiet: !!argOf("--quiet", false),
  session: argOf("--session", null),
};

const ts = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
// log：啰嗦的进度信息，--quiet 时静默。
const log = (...a) => { if (!OPTS.quiet) console.log(...a); };
// note：连接、注入、出错等关键事件，始终写入日志文件，便于事后排查。
const note = (...a) => { console.log("[" + ts() + "]", ...a); };

/* ============================================================
 *  一、数据库（threads 元数据 + thread_turns 轮次耗时）
 * ============================================================ */

let db = null;
let turnsDb = null;

/** WAL 模式下只读打开偶尔失败 —— 退化为快照副本 */
function openDbRo(p, tmpPrefix) {
  if (!fs.existsSync(p)) throw new Error("找不到 Codex 数据库：" + p);
  try {
    return new DatabaseSync(p, { readOnly: true });
  } catch (e) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
    const base = path.basename(p);
    for (const suf of ["", "-wal", "-shm"]) {
      const src = p + suf;
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, base + suf));
    }
    return new DatabaseSync(path.join(dir, base), { readOnly: true });
  }
}

/* 快照临时目录：进程退出不清理（database 还占着文件）。
   启动时把超过一天的旧目录扫掉，免得反复重启守护进程后在 %TEMP% 里越积越多。 */
function sweepOldSnapshots() {
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!/^cxsb-/.test(name)) continue;
      const dir = path.join(os.tmpdir(), name);
      try {
        if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) { /* 被别的进程占用就算了，下一轮再说 */ }
    }
  } catch (e) { /* ignore */ }
}

function getDb() {
  if (!db) db = openDbRo(DB_PATH, "cxsb-");
  return db;
}
function getTurnsDb() {
  if (!turnsDb) turnsDb = openDbRo(TURNS_DB_PATH, "cxsb-t-");
  return turnsDb;
}

/* 「屏幕上现在开着哪个会话」：
   threads.recency_at_ms 就是侧栏的最近顺序，取最上面那个；--session 显式指定时按 id 匹配。
   title 多半是空的，回退 first_user_message，再回退 rollout / session_index（见 resolveTitle）。 */
function pickThread(hint) {
  const db2 = getDb();
  const where = ["archived IS NULL OR archived = 0"];
  const params = [];
  if (hint) {
    where.push("(id = ? OR id LIKE ?)");
    params.push(hint, "%" + String(hint) + "%");
  }
  const r = db2.prepare(
    "SELECT id, rollout_path, title, first_user_message, model, cwd, tokens_used " +
    "FROM threads WHERE " + where.join(" AND ") + " ORDER BY recency_at_ms DESC LIMIT 1"
  ).get(...params);
  return r || null;
}

/** 本轮的官方耗时（thread_turns 只在轮次结束后落 duration_ms；进行中查不到就用 null） */
function turnDuration(threadId, turnId) {
  if (!threadId || !turnId) return null;
  try {
    const r = getTurnsDb().prepare(
      "SELECT status, duration_ms, started_at, completed_at FROM thread_turns WHERE thread_id=? AND turn_id=? LIMIT 1"
    ).get(threadId, turnId);
    return r || null;
  } catch (e) {
    return null;
  }
}

/* 本轮的**纯生成时间**：thread_items 里 reasoning / agentMessage 的流式时长之和。
   这两个类型的 started→completed 区间只覆盖模型在吐 token 的时间 —— 工具执行
   （commandExecution/mcpToolCall）、审批等待、排队 TTFT 都不在区间内。实测一轮
   376.9s 里这类区间合计 77.5s，其余全是工具与等待。正在流式的最后一项用 now 补全；
   一条可信区间都没有时返回 null，调用方退回整轮口径（含工具时间）。 */
const GEN_ITEM_TYPES = new Set(["reasoning", "agentMessage"]);
function turnGenMs(threadId, turnId, quantizeMs) {
  if (!threadId || !turnId) return null;
  try {
    const rows = getTurnsDb().prepare(
      "SELECT item_type, started_at_ms, completed_at_ms FROM thread_items " +
      "WHERE thread_id=? AND turn_id=? ORDER BY started_at_ms"
    ).all(threadId, turnId);
    let gen = 0;
    let seen = 0;
    const now = Date.now();
    for (const it of rows) {
      if (!GEN_ITEM_TYPES.has(String(it.item_type))) continue;
      const st = it.started_at_ms || 0;
      if (!st) continue;
      // 没落 completed 的就是正在流式的那一项，用 now 补全
      const en = it.completed_at_ms || now;
      if (en <= st) continue;
      gen += en - st;
      seen++;
    }
    if (!seen || gen <= 0) return null;
    // 进行中每拍都在长，量化一下，别让推送去重永远失效
    if (quantizeMs) gen = Math.round(gen / quantizeMs) * quantizeMs;
    return gen;
  } catch (e) {
    return null;
  }
}

/* ============================================================
 *  二、rollout 增量扫描（真实 token 用量都在这里）
 * ============================================================ */

/* 每个会话文件一份累计状态，按 offset 只读新增字节。
   换会话 / 文件被截断 / 首次见到 → 整扫一遍（最大的文件 ~12MB，一次性成本可忽略）。 */
const scanState = new Map();

function newScanState() {
  return {
    offset: 0,
    carry: "",
    turns: 0,
    steps: 0,
    toolCalls: 0,
    cumIn: 0, // 自己累加的输入（含缓存）；token_count 事件的累计值出现后以它为准
    cumCached: 0,
    cumOut: 0,
    cumTotal: 0,
    haveCumFromCount: false,
    lastIn: 0, // 最后一次调用的真实窗口占用（input_tokens 已含缓存）
    lastWindow: 0, // 运行时上报的 model_context_window
    curTurnId: null,
    curTurnStartTs: 0,
    curTurnOut: 0,
    curTurnSteps: 0,
    turnOpen: false, // task_started 之后还没等到 task_complete
    lastTurn: null, // 最近一次完结的轮次 {turnId, out, steps, startTs, endTs}
    firstUserMsg: null,
  };
}

/* 正则必须复用同一个对象（放行循环外）：字面量写进 while 条件会每次迭代新建正则、
   lastIndex 归零，匹配到一次就永远匹配 → 死循环。zcode-statusbar 的教训同样适用这里。 */
const RE_USAGE = /"usage":\{[^{}]*\}/g;
const RE_TOTAL_USAGE = /"total_token_usage":\{[^{}]*\}/g;
const RE_LAST_USAGE = /"last_token_usage":\{[^{}]*\}/g;
const RE_TS = /"timestamp":"([^"]+)"/;
const RE_TURN_ID = /"turn_id":"([0-9a-f-]{36})"/;
const RE_WINDOW = /"model_context_window":(\d+)/;
const RE_USER_TEXT = /"role":"user","content":\[\{"type":"input_text","text":"((?:[^"\\]|\\.)*)"/g;

function feedLine(s, line) {
  if (!line.startsWith("{")) return;
  if (line.includes('"type":"token_usage_record"')) {
    s.steps++;
    s.curTurnSteps++;
    let m, hit = null;
    RE_USAGE.lastIndex = 0;
    while ((m = RE_USAGE.exec(line))) hit = m[0];
    let u = null;
    if (hit) {
      try { u = JSON.parse(hit.slice(8)); } catch (e) {}
    } else {
      try { const j = JSON.parse(line); u = j && j.payload && j.payload.usage; } catch (e) {}
    }
    if (u) {
      s.cumIn += u.input_tokens || 0;
      s.cumCached += u.cached_input_tokens || 0;
      s.cumOut += u.output_tokens || 0;
      s.cumTotal += u.total_tokens || 0;
      s.curTurnOut += u.output_tokens || 0;
      if (u.input_tokens) s.lastIn = u.input_tokens;
    }
  } else if (line.includes('"type":"token_count"')) {
    // token_count 与 token_usage_record 成对出现；它的 total_token_usage 是官方累计口径
    let m, hit = null;
    RE_TOTAL_USAGE.lastIndex = 0;
    while ((m = RE_TOTAL_USAGE.exec(line))) hit = m[0];
    if (hit) {
      try {
        const u = JSON.parse(hit.slice(20));
        s.cumIn = u.input_tokens || s.cumIn;
        s.cumCached = u.cached_input_tokens || s.cumCached;
        s.cumOut = u.output_tokens || s.cumOut;
        s.cumTotal = u.total_tokens || s.cumTotal;
        s.haveCumFromCount = true;
      } catch (e) {}
    }
    let hit2 = null;
    RE_LAST_USAGE.lastIndex = 0;
    while ((m = RE_LAST_USAGE.exec(line))) hit2 = m[0];
    if (hit2) {
      try {
        const u = JSON.parse(hit2.slice(19));
        if (u.input_tokens) s.lastIn = u.input_tokens;
      } catch (e) {}
    }
    const w = RE_WINDOW.exec(line);
    if (w) s.lastWindow = Number(w[1]);
  } else if (line.includes('"type":"task_started"')) {
    const t = RE_TURN_ID.exec(line);
    const tsm = RE_TS.exec(line);
    s.turns++;
    s.turnOpen = true;
    s.curTurnId = t ? t[1] : s.curTurnId;
    s.curTurnStartTs = tsm ? Date.parse(tsm[1]) || 0 : 0;
    s.curTurnOut = 0;
    s.curTurnSteps = 0;
  } else if (line.includes('"type":"task_complete"')) {
    const tsm = RE_TS.exec(line);
    s.turnOpen = false;
    if (s.curTurnId) {
      s.lastTurn = {
        turnId: s.curTurnId,
        out: s.curTurnOut,
        steps: s.curTurnSteps,
        startTs: s.curTurnStartTs,
        endTs: tsm ? Date.parse(tsm[1]) || 0 : 0,
      };
    }
  } else if (line.includes('"type":"function_call"') || line.includes('"type":"custom_tool_call"')) {
    s.toolCalls++;
  } else if (!s.firstUserMsg && line.includes('"role":"user","content":')) {
    // 回退标题：第一条真人 user 消息（AGENTS.md / 环境上下文这类包装以 # 或 < 开头，跳过）
    let m, hit = null;
    RE_USER_TEXT.lastIndex = 0;
    while ((m = RE_USER_TEXT.exec(line))) hit = m[1];
    if (hit && !hit.startsWith("<") && !hit.startsWith("#")) {
      s.firstUserMsg = hit.replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim().slice(0, 60) || null;
    }
  }
}

/** 增量推进一个 rollout 文件；返回扫描状态（找不到文件返回 null） */
function scanRollout(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return null; }
  let s = scanState.get(file);
  if (!s || st.size < s.offset) {
    s = newScanState();
    scanState.set(file, s);
  }
  if (st.size === s.offset) return s;
  let fd;
  try { fd = fs.openSync(file, "r"); } catch (e) { return s; }
  try {
    let pos = s.offset;
    const CHUNK = 1024 * 1024;
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, st.size - pos));
    while (pos < st.size) {
      const want = Math.min(CHUNK, st.size - pos);
      const n = fs.readSync(fd, buf, 0, want, pos);
      if (n <= 0) break;
      let text = s.carry + buf.toString("utf8", 0, n);
      pos += n;
      let cut = 0; // 最后一个完整行的结尾
      for (let nl; (nl = text.indexOf("\n", cut)) >= 0; ) {
        feedLine(s, text.slice(cut, nl));
        cut = nl + 1;
      }
      s.carry = text.slice(cut);
      s.offset = pos - Buffer.byteLength(s.carry, "utf8");
    }
  } catch (e) {
    // 读一半坏了就先用到哪算哪，下一拍再补
  } finally {
    try { fs.closeSync(fd); } catch (e) {}
  }
  return s;
}

/* 会话标题：threads.title（多半为空）→ first_user_message → session_index.jsonl 的
   thread_name → rollout 第一条真人 user 消息。再没有就 (codex 会话)。 */
const titleIndexCache = { file: null, mtimeMs: 0, map: new Map() };
function titleFromIndex() {
  const p = path.join(CODEX_HOME, "session_index.jsonl");
  let st;
  try { st = fs.statSync(p); } catch (e) { return new Map(); }
  if (titleIndexCache.file === p && titleIndexCache.mtimeMs === st.mtimeMs) return titleIndexCache.map;
  const map = new Map();
  try {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const j = JSON.parse(t);
        if (j && j.id && j.thread_name) map.set(j.id, String(j.thread_name));
      } catch (e) {}
    }
  } catch (e) {}
  titleIndexCache.file = p;
  titleIndexCache.mtimeMs = st.mtimeMs;
  titleIndexCache.map = map;
  return map;
}

function resolveTitle(thread) {
  if (thread.title && String(thread.title).trim()) return String(thread.title).trim();
  if (thread.first_user_message && String(thread.first_user_message).trim()) {
    return String(thread.first_user_message).replace(/\s+/g, " ").trim().slice(0, 60);
  }
  const fromIndex = titleFromIndex().get(thread.id);
  if (fromIndex) return fromIndex;
  const s = scanRollout(thread.rollout_path);
  if (s && s.firstUserMsg) return s.firstUserMsg;
  return "(codex 会话)";
}

/* ============================================================
 *  三、指标计算（字段名与 zcode-statusbar 对齐，overlay 可以原样移植）
 * ============================================================ */

function readMetrics(hint) {
  const thread = pickThread(hint);
  const out = {
    sessionId: thread ? thread.id : null,
    title: null,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    tps: 0, // Codex 的 rollout 里没有逐请求生成耗时，累计速度没有诚实算法，条上不显示
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    cacheHit: null,
    running: false,
    model: thread ? thread.model || "" : "",
    cwd: thread ? String(thread.cwd || "").replace(/^\\\\\?\\/, "") : "",
    contextUsed: 0, // 当前上下文占用（真实 usage.input_tokens，已含缓存）
    contextWindow: 0,
    contextPct: null,
    hasTurn: false,
    turnId: null,
    turnStatus: null,
    turnRunning: false,
    turnPending: false,
    turnTps: 0,
    turnOutputTokens: 0,
    turnDurationMs: 0,
    turnGenMs: null, // 纯生成时间；null = thread_items 没有可信区间，tps 退回整轮口径
    turnRequests: 0,
    turnToolCalls: 0,
    updatedAt: Date.now(),
  };
  if (!thread || !thread.rollout_path) return out;

  const s = scanRollout(thread.rollout_path);
  if (!s) return out;

  out.title = resolveTitle(thread);
  out.turns = s.turns;
  out.steps = s.steps;
  out.toolCalls = s.toolCalls;
  out.inputTokens = s.cumIn;
  out.outputTokens = s.cumOut;
  out.cacheReadTokens = s.cumCached;
  out.totalTokens = s.haveCumFromCount ? s.cumTotal : s.cumIn + s.cumOut;
  out.cacheHit = out.inputTokens > 0 ? Math.min(100, (out.cacheReadTokens / out.inputTokens) * 100) : null;
  out.contextUsed = s.lastIn;
  out.contextWindow = s.lastWindow || 258400;
  out.contextPct = out.contextWindow > 0 && s.lastIn > 0 ? (s.lastIn / out.contextWindow) * 100 : null;

  /* --- 本问（最近一轮） ---
     轮次边界认 rollout 的 task_started / task_complete；耗时优先 thread_turns.duration_ms
     （官方口径），查不到再退回两个事件的时间差。tok/s = 输出 / 耗时，含工具时间，
     比纯生成速度偏低 —— tooltip 里写明，不藏着。 */
  const cur = s.turnOpen && s.curTurnId
    ? { turnId: s.curTurnId, out: s.curTurnOut, steps: s.curTurnSteps, startTs: s.curTurnStartTs, endTs: 0 }
    : s.lastTurn;
  if (cur) {
    out.hasTurn = true;
    out.turnId = cur.turnId;
    out.turnOutputTokens = cur.out;
    out.turnRequests = cur.steps;
    const tt = turnDuration(thread.id, cur.turnId);
    if (s.turnOpen) {
      out.turnRunning = true;
      out.turnStatus = tt ? String(tt.status) : "running";
      // 用户刚发问、第一个 usage 还没落盘 → 数字位置显示 --，不拿上一轮充数
      out.turnPending = out.turnOutputTokens <= 0;
      // 进行中轮的耗时/速度量化到秒：不去量化的话每拍都在变，推送去重永远失效
      out.turnDurationMs = tt && tt.duration_ms ? tt.duration_ms : Math.floor(Math.max(0, Date.now() - cur.startTs) / 1000) * 1000;
      out.turnGenMs = turnGenMs(thread.id, cur.turnId, 500);
    } else {
      out.turnStatus = tt ? String(tt.status) : "completed";
      out.turnDurationMs = (tt && tt.duration_ms) || Math.max(0, (cur.endTs || 0) - (cur.startTs || 0));
      out.turnGenMs = turnGenMs(thread.id, cur.turnId, 0);
    }
    /* 速度口径与 zcode-statusbar 对齐：优先纯生成时间（thread_items 里
       reasoning/agentMessage 的流式时长，工具执行/审批等待/排队都不在内）；
       没有可信区间时退回整轮耗时（含工具与等待，偏低）。 */
    const genMs = out.turnGenMs || out.turnDurationMs;
    out.turnTps = genMs > 500 ? (out.turnOutputTokens / genMs) * 1000 : 0;
  }
  out.running = out.turnRunning;
  return out;
}

const metricsFor = readMetrics;

/* ============================================================
 *  四、CDP 客户端（与 zcode-statusbar 相同）
 * ============================================================ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url, timeoutMs = 2500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.closed = true;
    this.ws = null;
  }
  open() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.wsUrl); } catch (e) { return reject(e); }
      this.ws = ws;
      const fail = (e) => { try { ws.close(); } catch (_) {} reject(e instanceof Error ? e : new Error(String(e))); };
      const timer = setTimeout(() => fail(new Error("WebSocket 连接超时")), 6000);
      ws.addEventListener("open", () => { clearTimeout(timer); this.closed = false; resolve(this); });
      ws.addEventListener("error", (ev) => { clearTimeout(timer); fail(new Error("WebSocket 错误")); });
      ws.addEventListener("close", () => {
        this.closed = true;
        for (const [, p] of this.pending) p.reject(new Error("连接已断开"));
        this.pending.clear();
      });
      ws.addEventListener("message", (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch (e) { return; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || "CDP 错误"));
          else p.resolve(msg.result);
        }
      });
    });
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP 未连接"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { this.pending.delete(id); reject(e); }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + " 超时")); }
      }, 10000);
    });
  }
  close() { try { this.ws && this.ws.close(); } catch (e) {} this.closed = true; }
}

/** 找到 Codex 主渲染进程的调试目标（app://-/index.html；webview 类目标天然被 type 过滤掉） */
function pickPage(targets) {
  const pages = (targets || []).filter(
    (t) => t && t.type === "page" && t.webSocketDebuggerUrl && !/^devtools:\/\//i.test(t.url || "")
  );
  if (!pages.length) return null;
  const score = (t) => {
    const u = String(t.url || "");
    let s = 0;
    if (/^app:\/\//i.test(u)) s += 12; // Codex 主窗口
    if (/index\.html/i.test(u)) s += 4;
    if (/^about:blank$/i.test(u)) s -= 5;
    return s;
  };
  return pages.slice().sort((a, b) => score(b) - score(a))[0];
}

async function discoverPage(port) {
  let lastErr = null;
  for (const host of ["127.0.0.1", "localhost"]) {
    try {
      const list = await httpJson("http://" + host + ":" + port + "/json/list");
      const p = pickPage(list);
      if (p) return p;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return null;
}

/* ============================================================
 *  五、主流程（与 zcode-statusbar 相同的骨架）
 * ============================================================ */

const OVERLAY_PATH = path.join(HERE, "overlay-codex.js");
function overlaySource() {
  return fs.readFileSync(OVERLAY_PATH, "utf8");
}

function pushExpr(m) {
  // 顺带回一个存活标记：页面上那份 overlay 可能自己没了。missing 让守护进程下一拍重装。
  return "(window.__codexSB&&window.__codexSB.update)"
    + "?(window.__codexSB.update(" + JSON.stringify(m) + "),'live')"
    + ":'missing'";
}

// 去重键：updatedAt 每轮都变，把它算进去等于完全没有去重 —— 只用稳定的指标字段。
function pushKey(m) {
  const { updatedAt, ...stable } = m;
  return JSON.stringify(stable);
}

// 心跳：指标长期不变时也定期重申一次（自愈 + 页面刷新后旧值最多停留这么久）。
const HEARTBEAT_TICKS = Math.max(1, Math.round(2500 / Math.max(500, OPTS.interval)));

/* ---------------- 单实例锁 ---------------- */
const LOCK_PATH = path.join(HERE, ".daemon.lock");

function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function readLockPid() {
  try { return Number(JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")).pid) || 0; } catch (e) { return 0; }
}

function acquireLock() {
  const existing = readLockPid();
  if (pidAlive(existing)) return false;
  try {
    const tmp = LOCK_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt: Date.now(), port: OPTS.port }));
    fs.renameSync(tmp, LOCK_PATH);
  } catch (e) {
    return true; // 锁文件写不进去时不阻塞启动
  }
  const release = () => {
    try { if (readLockPid() === process.pid) fs.unlinkSync(LOCK_PATH); } catch (e) {}
  };
  process.on("exit", release);
  return true;
}

async function run() {
  // 给启动脚本用的探针：已有注入器在跑则退 0，否则退 1
  if (argv.includes("--locked")) process.exit(pidAlive(readLockPid()) ? 0 : 1);

  // 停止：先把统计条从页面撤掉（连不上就交给页面看门狗兜底），再结束守护进程
  if (argv.includes("--stop")) {
    const pid = readLockPid();
    if (!pidAlive(pid)) {
      console.log("没有在运行的注入器。");
      process.exit(0);
    }
    try {
      const page = await discoverPage(OPTS.port);
      if (page) {
        const c = new CDP(page.webSocketDebuggerUrl);
        await c.open();
        await c.send("Runtime.evaluate", {
          expression: "(window.__codexSB&&window.__codexSB.remove)?window.__codexSB.remove():0",
        }).catch(() => {});
        c.close();
      }
    } catch (e) { /* 页面不在了就算了，看门狗会自己收尾 */ }
    try {
      process.kill(pid);
      console.log("已停止注入器（pid " + pid + "）。");
    } catch (e) {
      console.error("停止失败：" + e.message);
      process.exit(1);
    }
    process.exit(0);
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error("  ✗ 找不到 Codex 数据目录（" + DB_PATH + "）。请先运行一次 Codex。");
    process.exit(3);
  }

  // 自检模式：只读指标，不连 CDP
  if (OPTS.print) {
    log("");
    log("  Codex 底部数据统计条");
    log("  ─────────────────────────────────────────────");
    log("  数据库  : " + DB_PATH);
    log("  调试端口: 127.0.0.1:" + OPTS.port);
    log("");
    const m = metricsFor(OPTS.session);
    console.log(JSON.stringify(m, null, 2));
    console.log("");
    if (m.hasTurn) {
      console.log("  本问  " + [
        m.turnRunning ? "(进行中)" : "(" + (m.turnStatus || "?") + ")",
        (m.turnTps > 0 ? Math.round(m.turnTps) : "--") + " tok/s（" + (m.turnGenMs != null ? "纯生成" : "整轮口径") + "）",
        (m.turnOutputTokens / 1e3).toFixed(1) + "k tok",
        m.turnRequests + " 次请求",
        Math.round(m.turnDurationMs / 100) / 10 + "s",
      ].join("  ·  "));
    }
    console.log("  " + [
      m.turns + " 轮",
      m.steps + " 步",
      m.contextPct == null ? "上下文 --" : "上下文 " + m.contextPct.toFixed(1) + "%",
      (m.totalTokens / 1e6).toFixed(2) + "M tok",
      m.cacheHit == null ? "缓存 --" : "缓存命中 " + Math.round(m.cacheHit) + "%",
    ].join("  ·  "));
    return;
  }

  if (!acquireLock()) {
    note("已有注入器在运行（pid " + readLockPid() + "），本次启动退出。");
    note("如需重启，先运行: node codex-statusbar.mjs --stop");
    return;
  }

  const overlay = overlaySource();
  note("守护进程已启动：db=" + DB_PATH + "  port=127.0.0.1:" + OPTS.port + "  interval=" + OPTS.interval + "ms");
  let cdp = null;
  let targetKey = null;
  let injected = false;
  let newDocScriptId = null; // Page.addScriptToEvaluateOnNewDocument 返回的注册号
  let lastPush = "";
  let lastSession = "\u0000";
  let ticks = 0;
  let pushed = 0;
  let warnedPort = false;

  async function connect() {
    let page;
    try {
      page = await discoverPage(OPTS.port);
    } catch (e) {
      if (!warnedPort) {
        warnedPort = true;
        note("✗ 连不上调试端口 127.0.0.1:" + OPTS.port);
        note("  Codex 必须带 --remote-debugging-port 启动。");
        note("  codex-bg 看门狗会在 Codex 裸跑时自动修复端口；也可以等下一拍重试。");
      }
      return null;
    }
    warnedPort = false;
    if (!page) return null;

    const key = page.id || page.webSocketDebuggerUrl;
    if (cdp && !cdp.closed && key === targetKey) return cdp;
    if (cdp) cdp.close();

    const c = new CDP(page.webSocketDebuggerUrl);
    await c.open();
    await c.send("Page.enable").catch(() => {});
    await c.send("Runtime.enable").catch(() => {});
    cdp = c;
    targetKey = key;
    injected = false;
    newDocScriptId = null; // 注册表属于旧会话，随断开一起失效
    lastPush = "";
    note("已连接渲染进程 " + String(page.url || "").slice(0, 90));
    return cdp;
  }

  async function ensureInjected() {
    if (!cdp || cdp.closed || injected) return;
    try {
      // 页面刷新/导航后自动重装。先摘掉上一份注册再挂新的，避免同一文档上叠几份。
      if (newDocScriptId) {
        try {
          await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: newDocScriptId });
        } catch (e) { /* 旧会话的注册可能已随断开失效，忽略 */ }
        newDocScriptId = null;
      }
      const added = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: overlay });
      newDocScriptId = (added && added.identifier) || null;
      await cdp.send("Runtime.evaluate", { expression: overlay, returnByValue: false });
      injected = true;
      note("统计条已注入渲染进程");
    } catch (e) {
      note("✗ 注入失败：" + e.message);
    }
  }

  async function tick() {
    try {
      if (!(await connect())) return;
      await ensureInjected();
      if (!injected) return;

      const m = metricsFor(OPTS.session);
      if (m.sessionId !== lastSession) {
        lastSession = m.sessionId;
        note("跟随会话：" + (m.sessionId ? String(m.sessionId).slice(0, 8) + " " + (m.title || "") : "（无）"));
      }
      const key = pushKey(m);
      const beat = ++ticks % HEARTBEAT_TICKS === 0;
      if (key !== lastPush || beat) {
        const r = await cdp.send("Runtime.evaluate", { expression: pushExpr(m), returnByValue: true });
        if (r && r.result && r.result.value === "missing") {
          injected = false;
          lastPush = "";
          note("页面上没有统计条了（__codexSB 不在），下一拍重新注入");
          return;
        }
        if (key !== lastPush) {
          lastPush = key;
          log("  [" + ts() + "] 指标已更新：" + [
            m.turns + " 轮", m.steps + " 步",
            m.contextPct == null ? "上下文 --" : "上下文 " + m.contextPct.toFixed(1) + "%",
            (m.totalTokens / 1e6).toFixed(2) + "M tok",
            m.cacheHit == null ? "缓存 --" : "缓存 " + Math.round(m.cacheHit) + "%",
          ].join(" · "));
        }
        pushed++;
      }
    } catch (e) {
      if (cdp) { cdp.close(); cdp = null; injected = false; }
    }
  }

  // 退出时主动把条撤掉、内边距还原。
  async function cleanup() {
    if (!cdp || cdp.closed) return;
    try {
      await Promise.race([
        cdp.send("Runtime.evaluate", {
          expression: "(window.__codexSB&&window.__codexSB.remove)?window.__codexSB.remove():0",
          returnByValue: false,
        }),
        new Promise((r) => setTimeout(r, 800)),
      ]);
    } catch (e) { /* 页面已经关了就算了 */ }
    cdp.close();
  }
  process.on("SIGINT", () => {
    cleanup().then(() => { log("\n  已停止（统计条已撤掉、输入框内边距已还原）。"); process.exit(0); });
  });
  process.on("SIGTERM", () => { cleanup().then(() => process.exit(0)); });

  // 首轮快速重试（Codex 冷启动要几秒；没开 Codex 时这些拍都会静默失败，之后靠 setInterval 等它出现）
  for (let i = 0; i < 8; i++) {
    await tick();
    if (injected) break;
    await sleep(750);
  }

  sweepOldSnapshots();
  setInterval(tick, Math.max(500, OPTS.interval));
}

await run();
