// 诊断脚本：dump Codex 输入框的祖先链（布局探测用，不属于运行时）
async function main() {
  const list = await (await fetch("http://127.0.0.1:9224/json/list")).json();
  const page = list.find((t) => t.type === "page" && /^app:\/\//.test(t.url || ""));
  if (!page) { console.log("no page"); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const expr = `(function () {
    var eds = document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=""],[data-composer-surface-variant]');
    var out = [];
    for (var k = 0; k < eds.length; k++) {
      var e = eds[k];
      var r = e.getBoundingClientRect();
      if (r.width < 60 || r.height < 6) continue;
      out.push('EDITABLE ' + e.tagName + ' testid=' + (e.getAttribute('data-testid') || '') + ' comp=' + (e.getAttribute('data-composer-surface-variant') || '') + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height) + ' bottom=' + r.bottom.toFixed(1));
      var p = e.parentElement, n = 0;
      while (p && p !== document.body && n < 14) {
        var pr = p.getBoundingClientRect();
        var cs = getComputedStyle(p);
        out.push('  L' + n + ' ' + p.tagName +
          ' attr=' + Object.keys(p.dataset || {}).filter(function (d) { return /composer|dock|surface/.test(d); }).map(function (d) { return d + '=' + p.dataset[d]; }).join(',') +
          ' bottom=' + pr.bottom.toFixed(1) + ' h=' + Math.round(pr.height) + ' w=' + Math.round(pr.width) +
          ' padB=' + cs.paddingBottom + ' radius=' + cs.borderTopLeftRadius + ' bg=' + cs.backgroundColor);
        p = p.parentElement; n++;
      }
      break;
    }
    if (!out.length) out.push('(no editable found)');
    return out.join('\\n');
  })()`;
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
  const r = await new Promise((res) => ws.onmessage = (e) => res(JSON.parse(e.data)));
  console.log(r.result.result.value);
  ws.close();
}
main().catch((e) => console.log("ERR", e.message));
