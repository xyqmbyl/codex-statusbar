// 诊断脚本：列出全部可编辑元素及其矩形
async function main() {
  const list = await (await fetch("http://127.0.0.1:9224/json/list")).json();
  const page = list.find((t) => t.type === "page" && /^app:\/\//.test(t.url || ""));
  if (!page) { console.log("no page"); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const expr = `(function () {
    var eds = document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=""],[data-composer-surface-variant]');
    var out = ['eds=' + eds.length];
    for (var i = 0; i < eds.length; i++) {
      var e = eds[i], r = e.getBoundingClientRect();
      out.push('ed' + i + ' ' + e.tagName +
        ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height) +
        ' bottom=' + r.bottom.toFixed(1) + ' top=' + r.top.toFixed(1) +
        ' variant=' + (e.getAttribute('data-composer-surface-variant') || '') +
        ' layout=' + (e.getAttribute('data-composer-layout') || ''));
    }
    return out.join('\\n');
  })()`;
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
  const r = await new Promise((res) => ws.onmessage = (ev) => res(JSON.parse(ev.data)));
  console.log(r.result && r.result.result ? r.result.result.value : JSON.stringify(r).slice(0, 300));
  ws.close();
}
main().catch((e) => console.log("ERR", e.message));
