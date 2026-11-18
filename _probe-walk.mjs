// 诊断脚本：把 overlay 的 findComposerWrap/isPaintedCard 原样跑一遍，打印每层判定
async function main() {
  const list = await (await fetch("http://127.0.0.1:9224/json/list")).json();
  const page = list.find((t) => t.type === "page" && /^app:\/\//.test(t.url || ""));
  if (!page) { console.log("no page"); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const expr = `(function () {
    var PIN_TOL = 8;
    function isPaintedCard(el, h) {
      if (!el || !h || h > 400) return false;
      var cs;
      try { cs = window.getComputedStyle(el); } catch (e) { return false; }
      if (!cs) return false;
      var rad = parseFloat(cs.borderTopLeftRadius || "0");
      if (rad > 0) return true;
      var m = /^rgba?\\(([^)]+)\\)$/.exec(cs.backgroundColor || "");
      if (!m) return false;
      var parts = m[1].split(",");
      var a = parts.length > 3 ? parseFloat(parts[3]) : 1;
      return !(a === 0);
    }
    var cb = (window.__codexSB && window.__codexSB.probe) ? window.__codexSB.probe().composerBottom : null;
    var vh = window.innerHeight || 0;
    var budget = (cb === null || cb === undefined) ? 0 : (vh - cb) + 220;
    var eds = document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=""],[data-composer-surface-variant]');
    var out = ['cb=' + cb + ' vh=' + vh + ' budget=' + budget.toFixed(1) + ' eds=' + eds.length];
    for (var i = 0; i < eds.length; i++) {
      var e = eds[i], r;
      try { r = e.getBoundingClientRect(); } catch (err) { continue; }
      if (!r || !vh || r.width < 60 || r.height < 6) { out.push('ed' + i + ' skip-size'); continue; }
      if (r.bottom <= 0 || r.top >= vh) { out.push('ed' + i + ' skip-vis'); continue; }
      out.push('ed' + i + ' ' + e.tagName + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height) + ' bottom=' + r.bottom.toFixed(1));
      var p = e.parentElement, n = 0;
      while (p && p !== document.body && p !== document.documentElement && n < 16) {
        var pr;
        try { pr = p.getBoundingClientRect(); } catch (err2) { break; }
        if (!pr.height) { out.push('  L' + n + ' h=0 skip'); p = p.parentElement; n++; continue; }
        if (pr.width < r.width * 0.5) { out.push('  L' + n + ' break-width w=' + Math.round(pr.width)); break; }
        var painted = isPaintedCard(p, pr.height);
        var pinned = pr.bottom >= vh - PIN_TOL;
        out.push('  L' + n + ' bottom=' + pr.bottom.toFixed(1) + ' h=' + Math.round(pr.height) + ' w=' + Math.round(pr.width) + ' pinned=' + pinned + ' painted=' + painted + (painted ? ' rad=' + getComputedStyle(p).borderTopLeftRadius + ' bg=' + getComputedStyle(p).backgroundColor : ''));
        if (pinned && !painted) {
          if (!budget || pr.height > budget) { out.push('  -> break-budget h=' + Math.round(pr.height)); break; }
          out.push('  -> RETURN this level');
          return out.join('\\n');
        }
        p = p.parentElement; n++;
      }
      out.push('  (walk ended, no wrap)');
      break;
    }
    return out.join('\\n');
  })()`;
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
  const r = await new Promise((res) => ws.onmessage = (ev) => res(JSON.parse(ev.data)));
  console.log(r.result && r.result.result ? r.result.result.value : JSON.stringify(r).slice(0, 300));
  ws.close();
}
main().catch((e) => console.log("ERR", e.message));
