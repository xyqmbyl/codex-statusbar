// 校验脚本：zcode-statusbar 的口径（db.sqlite 聚合）对 rollout 原始 model_io 记录逐项对账
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOME = os.homedir();
const DB = path.join(HOME, ".zcode", "cli", "db", "db.sqlite");

function openRo(p) {
  try {
    return new DatabaseSync(p, { readOnly: true });
  } catch (e) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zsbv-"));
    const base = path.basename(p);
    for (const suf of ["", "-wal", "-shm"]) {
      if (fs.existsSync(p + suf)) fs.copyFileSync(p + suf, path.join(dir, base + suf));
    }
    return new DatabaseSync(path.join(dir, base), { readOnly: true });
  }
}
const db = openRo(DB);

// 状态栏的认会话逻辑：有 running 轮优先，否则最近更新的
let sid = null;
try {
  const r = db.prepare("SELECT session_id AS id FROM turn_usage WHERE status='running' ORDER BY started_at DESC LIMIT 1").get();
  if (r) sid = r.id;
} catch (e) {}
if (!sid) sid = db.prepare("SELECT id FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 1").get().id;

const s = db.prepare("SELECT id, title, time_updated FROM session WHERE id=?").get(sid);
console.log("会话:", sid.slice(0, 14) + "…", " 标题:", (s.title || "(无标题)").slice(0, 30));

// —— 官方聚合（状态栏读的就是这些）——
const agg = db.prepare(
  "SELECT COUNT(*) AS turns, COALESCE(SUM(model_request_count),0) AS steps, " +
  "COALESCE(SUM(tool_call_count),0) AS tools, COALESCE(SUM(input_tokens),0) AS inp, " +
  "COALESCE(SUM(output_tokens),0) AS outp, COALESCE(SUM(cache_read_input_tokens),0) AS cached, " +
  "COALESCE(SUM(computed_total_tokens),0) AS total FROM turn_usage WHERE session_id=?"
).get(sid);
console.log("\n—— db.sqlite turn_usage 聚合（状态栏口径）——");
console.log("轮", agg.turns, " 步", agg.steps, " 工具", agg.tools, " in", agg.inp, " out", agg.outp, " cached", agg.cached, " total", agg.total);

// —— 独立整扫 rollout model_io ——
const rollout = path.join(HOME, ".zcode", "cli", "rollout", `model-io-${sid}.jsonl`);
if (!fs.existsSync(rollout)) {
  console.log("\n(找不到 rollout 文件，跳过对账:", rollout, ")");
  process.exit(0);
}
const lines = fs.readFileSync(rollout, "utf8").split("\n").filter((l) => l.startsWith("{") && l.includes('"type":"model_io"'));
let records = 0, sumIn = 0, sumOut = 0, sumCached = 0, last = null;
for (const l of lines) {
  let hit = null, m;
  const re = /"usage":\{[^{}]*\}/g;
  while ((m = re.exec(l))) hit = m[0];
  let u = null;
  if (hit) { try { u = JSON.parse(hit.slice(8)); } catch (e) {} }
  else { try { u = JSON.parse(l).usage; } catch (e) {} }
  if (!u) continue;
  records++;
  sumIn += u.inputTokens || 0;
  sumOut += u.outputTokens || 0;
  sumCached += u.cacheReadTokens || 0;
  last = u;
}
const sizeMB = (fs.statSync(rollout).size / 1048576).toFixed(1);
console.log("\n—— rollout 整扫（", sizeMB, "MB，model_io 记录", records, "）——");
console.log("步", records, " in", sumIn, " out", sumOut, " cached", sumCached, " in+out", sumIn + sumOut);
console.log("最后一条 usage:", JSON.stringify(last));

console.log("\n—— 对账 ——");
const row = (name, a, b) => {
  const diff = a - b;
  console.log(name + "：db", a, " vs rollout", b, " 差", diff, a ? "(" + (Math.abs(diff) / a * 100).toFixed(2) + "%)" : "");
};
row("步数", agg.steps, records);
row("输出 token", agg.outp, sumOut);
row("输入 token", agg.inp, sumIn);
row("缓存读 token", agg.cached, sumCached);
if (last && last.inputTokens) {
  console.log("\n（上下文口径参考）最后一条请求 inputTokens:", last.inputTokens,
    "≈ 当前窗口占用；db 里 turn_usage 是逐轮累计口径，两者含义不同");
}
db.close();
