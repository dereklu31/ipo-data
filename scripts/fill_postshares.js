/* 从披露易英文招股章程「SHARE CAPITAL」章节抽取“全球发售完成后（超额配股权未行使）已发行股份总数”，
   写入 deal_details.js 对应条目的 postShares。确定性脚本，不靠模型。
   用法：node scripts/fill_postshares.js            （处理 ipo_data.js 里所有在招股）
        node scripts/fill_postshares.js --pdf x.pdf --shares 6561000   （本地只测解析）
   依赖：node>=18（fetch）、pdftotext（poppler-utils）。
   校验：总数必须等于表内其余若干行之和；发售股数/总数须在 2%–30%；否则不写。 */
const fs = require('fs'), vm = require('vm'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

const UA = { 'User-Agent': 'Mozilla/5.0 (ipo-data workflow)' };
const HK = 'https://www1.hkexnews.hk';

/* ---------- 解析 ----------
   只在「SHARE CAPITAL」章节内找“全球发售完成后”股本表；多列表（超额配股权/发售量调整权各种组合）只取最左列
   （= 均未行使）；总数必须 = 发售股数 + 表内其余若干行之和，且发售股数/总数在 2%–30%。任一不满足就不写。 */
const ANCHOR = /\b(immediately|upon)\b.{0,70}\b(Global Offering|completion)\b/i;
function nums(line) { return (line.match(/\b\d{1,3}(?:,\d{3})+\b/g) || []).map(s => +s.replace(/,/g, '')); }
function subsetSum(target, pool) {                    // pool 很小，暴力找非空子集
  const n = Math.min(pool.length, 14);
  for (let m = 1; m < (1 << n); m++) { let s = 0; for (let i = 0; i < n; i++) if (m & (1 << i)) s += pool[i]; if (s === target) return true; }
  return false;
}
function parseTotal(text, offerShares) {
  if (!offerShares) return null;                      // 没有发售股数就无法交叉校验，宁缺毋滥
  const lines = text.split(/\r?\n/);
  const s0 = lines.findIndex((l, i) => i > 300 && /^\s*SHARE CAPITAL\s*$/.test(l));   // 跳过目录
  if (s0 < 0) return null;
  const e0 = Math.min(lines.length, s0 + 260);
  const isHeading = l => { const t = l.trim(); return /^[A-Z][A-Z ,'&()-]{3,}$/.test(t) && !/^SHARE CAPITAL$/.test(t); };
  for (let i = s0; i < e0; i++) {
    const win = [lines[i], lines[i + 1] || '', lines[i + 2] || ''].join(' ').replace(/\s+/g, ' ');
    if (!ANCHOR.test(win) && !/not exercised/i.test(win)) continue;
    if (/fully exercised/i.test(win) && !/not exercised/i.test(win)) continue;   // “悉数行使”那张表跳过
    const col = [];
    for (let j = i + 1; j < Math.min(e0, i + 45); j++) {
      if (j > i + 3 && (ANCHOR.test(lines[j]) || isHeading(lines[j]))) break;  // 下一段/下一张表开始
      const ns = nums(lines[j]).filter(v => v >= 10000);
      if (ns.length) col.push(ns[0]);                                           // 只取最左列
    }
    const uniq = [...new Set(col)];
    if (!uniq.includes(offerShares)) continue;                                  // 发售股数必须在表内
    for (const cand of uniq.filter(v => v > offerShares).sort((a, b) => b - a)) {
      const rest = uniq.filter(v => v < cand && v !== offerShares);
      if (!subsetSum(cand - offerShares, rest)) continue;
      const r = offerShares / cand;
      if (r < 0.02 || r > 0.30) continue;
      return { total: cand, line: i + 1, offerInTable: true, ratio: r };
    }
  }
  return null;
}

/* ---------- 披露易：代码 → stockId → 近 120 天 “GLOBAL OFFERING” 英文文件 ---------- */
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
async function getText(url) { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(r.status + ' ' + url); return r.text(); }
async function prospectusLinks(code) {
  const c5 = code.replace(/\.HK$/i, '').padStart(5, '0');
  const pre = await getText(`${HK}/search/prefix.do?callback=callback&lang=EN&type=A&name=${c5}&market=SEHK`);
  const info = JSON.parse(pre.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, ''));
  const hit = (info.stockInfo || []).find(s => s.code === c5);
  if (!hit) throw new Error('prefix 未找到 ' + c5);
  const to = new Date(), from = new Date(Date.now() - 120 * 864e5);
  const q = `${HK}/search/titleSearchServlet.do?sortDir=0&sortByOptions=DateTime&category=0&market=SEHK&stockId=${hit.stockId}` +
            `&documentType=-1&fromDate=${ymd(from)}&toDate=${ymd(to)}&title=&searchType=0&t1code=-2&t2Gcode=-2&t2code=-2&rowRange=100&lang=en`;
  const res = JSON.parse(JSON.parse(await getText(q)).result || '[]');
  const mb = s => { const m = String(s || '').match(/([\d.]+)\s*(KB|MB)/i); return m ? (+m[1]) * (/MB/i.test(m[2]) ? 1024 : 1) : 0; };
  return res.filter(d => /GLOBAL OFFERING/i.test(d.TITLE) && /\.pdf$/i.test(d.FILE_LINK))
            .sort((a, b) => mb(b.FILE_INFO) - mb(a.FILE_INFO))          // 先试最大的（招股章程全文）
            .slice(0, 2).map(d => HK + d.FILE_LINK);
}
async function pdfText(url) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));
  const pdf = path.join(tmp, 'p.pdf'), txt = path.join(tmp, 'p.txt');
  const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(r.status + ' ' + url);
  fs.writeFileSync(pdf, Buffer.from(await r.arrayBuffer()));
  execFileSync('pdftotext', ['-layout', pdf, txt], { stdio: 'ignore' });
  return fs.readFileSync(txt, 'utf8');
}

/* ---------- 写回 deal_details.js：在该条目 shares 行后插入/替换 postShares 行 ---------- */
function upsertPostShares(src, code, total) {
  const head = src.indexOf(`"${code}": {`); if (head < 0) return { src, changed: false };
  const end = src.indexOf('\n  }', head);                           // 条目结束（两格缩进的 }）
  const body = src.slice(head, end);
  const line = `    postShares: ${total},   // 招股章程「SHARE CAPITAL」：全球发售完成后(超额配股权未行使)已发行股份总数`;
  let nb;
  if (/\n\s*postShares\s*:[^\n]*/.test(body)) nb = body.replace(/\n\s*postShares\s*:[^\n]*/, '\n' + line);
  else if (/\n\s*shares\s*:[^\n]*/.test(body)) nb = body.replace(/(\n\s*shares\s*:[^\n]*)/, `$1\n${line}`);
  else nb = body.replace(/\{\s*\n/, `{\n${line}\n`);
  return { src: src.slice(0, head) + nb + src.slice(end), changed: nb !== body };
}

async function main() {
  const a = process.argv.slice(2);
  if (a[0] === '--pdf') {                                              // 本地解析自测
    const txt = path.extname(a[1]) === '.txt' ? fs.readFileSync(a[1], 'utf8')
              : (execFileSync('pdftotext', ['-layout', a[1], '-']).toString());
    console.log(JSON.stringify(parseTotal(txt, +(a[3] || 0) || null)));
    return;
  }
  const ctx = { window: {} }; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('ipo_data.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('deal_details.js', 'utf8'), ctx);
  const deals = ctx.window.IPO_DEALS || {};
  const codes = (ctx.window.IPO_OVERVIEW || []).map(o => o.code).filter(c => c && deals[c]);
  let src = fs.readFileSync('deal_details.js', 'utf8'); const log = [];
  for (const code of codes) {
    const d = deals[code];
    try {
      let got = null;
      for (const url of await prospectusLinks(code)) {
        got = parseTotal(await pdfText(url), +d.shares || null);
        if (got) { got.url = url; break; }
      }
      if (!got) { log.push(`::warning::${code} 未能从招股章程解析出发行后总股本（保留原值${d.postShares ? ' ' + d.postShares : '：无'}）`); continue; }
      if (+d.postShares === got.total) { log.push(`${code} postShares=${got.total} 已一致`); continue; }
      if (d.postShares) log.push(`::warning::${code} postShares 原值 ${d.postShares} 与招股章程 ${got.total} 不符，按招股章程更正`);
      const u = upsertPostShares(src, code, got.total); src = u.src;
      log.push(`${code} postShares=${got.total}（发售占比 ${(got.ratio * 100).toFixed(1)}%，${got.offerInTable ? '表内含发售股数✓' : '表内未见发售股数'}）← ${got.url}`);
    } catch (e) { log.push(`::warning::${code} 抓取发行后总股本失败：${e.message}`); }
  }
  // 写回前再校验一次是合法 JS
  const chk = { window: {} }; vm.createContext(chk); vm.runInContext(src, chk);
  fs.writeFileSync('deal_details.js', src);
  console.log(log.join('\n') || '无在招股需要处理');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### 发行后总股本（脚本抓取）\n' + log.map(l => '- ' + l.replace(/^::warning::/, '⚠ ')).join('\n') + '\n');
}
module.exports = { parseTotal, upsertPostShares };
if (require.main === module) main().catch(e => { console.log('::warning::fill_postshares 异常：' + e.message); process.exit(0); });
