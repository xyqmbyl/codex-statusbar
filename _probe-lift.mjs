// 诊断脚本：手动模拟 reserveRoom 的抬升动作，验证「给贴底包裹层加 padding-bottom 能否抬起输入框」
async function main() {
  const list = await (await fetch("http://127.0.0.1:9224/json/list")).json();
  const page = list.find((t) => t.type === "page" && /^app:\/\//.test(t.url || ""));
  if (!page) { console.log("no page"); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const expr = `(function () {
    var eds = document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=""],[data-composer-surface-variant]');
    var e = null;
    for (var k = 0; k < eds.length; k++) {
      var r = eds[k].getBoundingClientRect();
      if (r && r.width >= 60 && r.height >= 6) { e = eds[k]; break; }
    }
    if (!e) return 'no editable';
    var vh = window.innerHeight;
    var before = e.getBoundingClientRect().bottom;
    // 沿祖先链找「贴底、非卡片、高度 <= 300」的包裹层
    var p = e.parentElement, n = 0, found = null, log = [];
    while (p && p !== document.body && n < 16) {
      var pr = p.getBoundingClientRect();
      if (!pr.height) { p = p.parentElement; n++; continue; }
      if (pr.width < r0(e).width * 0.5) { log.push('L' + n + ' break-width'); break; }
      if (pr.bottom >= vh - 8) {
        var cs = getComputedStyle(p);
        var painted = parseFloat(cs.borderTopLeftRadius) > 0 || !/rgba\\(\\d+, \\d+, \\d+, 0\\)/.test(cs.backgroundColor);
        log.push('L' + n + ' pinned h=' + Math.round(pr.height) + ' painted=' + painted);
        if (!painted && pr.height <= 300) { found = p; break; }
      }
      p = p.parentElement; n++;
    }
    if (!found) return 'no wrap found\\n' + log.join('\\n');
    var base = parseFloat(getComputedStyle(found).paddingBottom) || 0;
    found.style.paddingBottom = (base + 30) + 'px';
    var after = e.getBoundingClientRect().bottom;
    var result = 'host=' + found.tagName + ' base=' + base + ' composerBottom before=' + before.toFixed(1) + ' after=' + after.toFixed(1) + ' lifted=' + (before - after).toFixed(1) + ' spaceAfter=' + (vh - after).toFixed(1);
    found.style.paddingBottom = '';
    return result;
    function r0(el) { return el.getBoundingClientRect(); }
  })()`;
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
  const r = await new Promise((res) => ws.onmessage = (ev) => res(JSON.parse(ev.data)));
  console.log(r.result && r.result.result ? r.result.result.value : JSON.stringify(r).slice(0, 400));
  ws.close();
}
main().catch((e) => console.log("ERR", e.message));
