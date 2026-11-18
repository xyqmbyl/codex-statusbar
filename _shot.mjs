// 诊断脚本：CDP 截图（确认统计条视觉效果用）
import fs from "node:fs";

async function main() {
  const list = await (await fetch("http://127.0.0.1:9224/json/list")).json();
  const page = list.find((t) => t.type === "page" && /^app:\/\//.test(t.url || ""));
  if (!page) { console.log("no page"); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } }));
  const r = await new Promise((res) => ws.onmessage = (ev) => res(JSON.parse(ev.data)));
  const data = r.result && r.result.data;
  if (!data) { console.log("no screenshot:", JSON.stringify(r).slice(0, 200)); return; }
  fs.writeFileSync(new URL("./_bar-shot.png", import.meta.url), Buffer.from(data, "base64"));
  console.log("saved _bar-shot.png");
  // 顺手把条附近的裁剪坐标打出来，方便看图
  ws.send(JSON.stringify({
    id: 2, method: "Runtime.evaluate",
    params: { expression: "(function(){var el=document.getElementById('cxsb-bar');var r=el.getBoundingClientRect();return JSON.stringify({left:r.left,top:r.top,right:r.right,bottom:r.bottom});})()", returnByValue: true },
  }));
  const r2 = await new Promise((res) => ws.onmessage = (ev) => res(JSON.parse(ev.data)));
  console.log("bar rect:", r2.result.result.value);
  ws.close();
}
main().catch((e) => console.log("ERR", e.message));
