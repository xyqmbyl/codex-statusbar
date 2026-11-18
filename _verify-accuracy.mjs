// 校验脚本：把 codex-statusbar 的口径与 Codex 官方落盘数据逐项对账
// 独立重扫（不用守护进程的增量缓存），全部只读。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOME = os.homedir();
const db = new DatabaseSync(path.join(HOME, ".codex", "state_5.sqlite"), { readOnly: true });
const tdb = new DatabaseSync(path.join(HOME, ".codex", "thread_history_1.sqlite"), { readOnly: true });

const thread = db.prepare(
  "SELECT id, rollout_path, title, first_user_message, tokens_used, model FROM threads " +
  "WHERE archived IS NULL OR archived = 0 ORDER BY recency_at_ms DESC LIMIT 1"
).get();
console.log("会话:", thread.id.slice(0, 8), " model:", thread.model, " cwd:", String(thread.cwd).replace(/^\\\\\?\\/, ""));
console.log("Codex 官方 tokens_used:", thread.tokens_used);

// —— 独立整扫 rollout ——
const lines = fs.readFileSync(thread.rollout_path, "utf8").split("\n").filter((s) => s.trim());
let steps = 0, taskStarted = 0, taskComplete = 0, toolCalls = 0;
let sumOut = 0, sumIn = 0, sumCached = 0; // 自己逐条累加
let lastTotal = null, lastLast = null, lastWindow = 0;
for (const l of lines) {
  if (!l.startsWith("{")) continue;
  if (l.includes('"type":"token_usage_record"')) {
    steps++;
    const m = /"usage":\{[^{}]*\}/g; let h, hit = null;
    while ((h = m.exec(l))) hit = h[0];
    if (hit) {
      const u = JSON.parse(hit.slice(8));
      sumIn += u.input_tokens || 0;
      sumCached += u.cached_input_tokens || 0;
      sumOut += u.output_tokens || 0;
    }
  } else if (l.includes('"type":"token_count"')) {
    const m1 = /"total_token_usage":\{[^{}]*\}/g; let h1, hit1 = null;
    while ((h1 = m1.exec(l))) hit1 = h1[0];
    if (hit1) lastTotal = JSON.parse(hit1.slice(20));
    const m2 = /"last_token_usage":\{[^{}]*\}/g; let h2, hit2 = null;
    while ((h2 = m2.exec(l))) hit2 = h2[0];
    if (hit2) lastLast = JSON.parse(hit2.slice(19));
    const w = /"model_context_window":(\d+)/.exec(l);
    if (w) lastWindow = Number(w[1]);
  } else if (l.includes('"type":"task_started"')) taskStarted++;
  else if (l.includes('"type":"task_complete"')) taskComplete++;
  else if (l.includes('"type":"function_call"') || l.includes('"type":"custom_tool_call"')) toolCalls++;
}
const sizeMB = (fs.statSync(thread.rollout_path).size / 1048576).toFixed(1);
console.log("\n—— rollout 整扫（文件", sizeMB, "MB，", lines.length, "行）——");
console.log("步数(token_usage_record):", steps, "  task_started:", taskStarted, " task_complete:", taskComplete, " 工具调用:", toolCalls);
console.log("逐条累加: in", sumIn, " cached", sumCached, " out", sumOut, " 合计", sumIn + sumOut);
console.log("最后一条 token_count.total_token_usage:", JSON.stringify(lastTotal));
console.log("最后一条 last_token_usage:", JSON.stringify(lastLast), " window:", lastWindow);

// —— 与官方账本对 ——
const official = thread.tokens_used;
const mineTotal = lastTotal ? lastTotal.total_tokens : sumIn + sumOut;
console.log("\n—— 对账 ——");
console.log("合计 token：官方", official, " vs 我的", mineTotal, " 差", official - mineTotal,
  (Math.abs(official - mineTotal) / Math.max(1, official) * 100).toFixed(2) + "%");
console.log("轮数：官方 thread_turns", tdb.prepare("SELECT COUNT(*) AS n FROM thread_turns WHERE thread_id=?").get(thread.id).n,
  " vs rollout task_started", taskStarted);
// 上下文占用核对：last_token_usage.input_tokens ÷ window
if (lastLast && lastWindow) {
  console.log("上下文占用：", lastLast.input_tokens, "/", lastWindow, "=",
    (lastLast.input_tokens / lastWindow * 100).toFixed(1) + "%",
    " （input_tokens 已含 cached:", lastLast.cached_input_tokens, "）");
}
db.close(); tdb.close();
