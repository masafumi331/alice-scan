// GS1 文字列（GS1-128 / GS1 DataMatrix）を AI ごとに分解し、LOT・使用期限を「確かめたうえで」取り出す。
// 2026-11-13 改版（v2）。考え方:
//   ・メーカー別の固定位置では読まない。AI（01=GTIN, 10=LOT, 17=期限, 21=シリアル…）の長さと区切り GS(0x1D) だけで分ける
//   ・読めたことと正しいことを分ける。長さ・文字種・日付の実在・重複・途中切れを検査し、怪しいものは q="check"（要確認）にする
//   ・GS が抜けた可変長項目の境界は推測で直さない。日付として成り立つ分け方があれば「候補」（alts）として出し、人が箱の印字と照らして選ぶ
// 受け付ける形:
//   1) リーダー生出力: "]C1" / "]d2" / "]e0" / "]Q3" の先頭記号（あれば）＋ 区切り GS(0x1D) 入り
//   2) 括弧付き HRI: "(01)04547327123624(17)290630(10)260709A10F"
//   3) 区切り無しの生文字列（可変長 AI は末尾まで。GS が抜けたかどうかは文字列だけでは決められない → noGs / alts で知らせる）
(function (root) {
  const GS = "\u001d";
  const VERSION = "2026-11-13";
  // 事前定義長の AI（後ろに GS が要らない）
  const FIXED = { "00": 18, "01": 14, "02": 14, "03": 14, "04": 16, "11": 6, "12": 6, "13": 6, "14": 6, "15": 6, "16": 6, "17": 6, "18": 6, "19": 6, "20": 2,
    "410": 13, "411": 13, "412": 13, "413": 13, "414": 13, "415": 13, "416": 13 };
  // 可変長の AI と最大長（超えていたら GS 抜け・読み違いを疑う）
  const VARMAX = { "10": 20, "21": 20, "22": 20, "235": 28, "240": 30, "241": 30, "242": 6, "243": 20, "250": 30, "251": 30, "253": 30, "254": 20, "255": 25,
    "30": 8, "37": 8, "400": 30, "401": 30, "402": 17, "403": 30, "420": 20, "421": 12, "422": 3, "423": 15, "424": 3, "425": 15, "426": 3, "427": 3,
    "710": 20, "711": 20, "712": 20, "713": 20, "714": 20, "715": 20, "716": 20,
    "7001": 13, "7002": 30, "7003": 10, "7004": 4, "7005": 12, "7006": 6, "7007": 12, "7008": 3, "7009": 10, "7010": 2, "7011": 10, "7020": 20, "7021": 20, "7022": 20, "7023": 30,
    "8001": 14, "8002": 20, "8003": 30, "8004": 30, "8005": 6, "8006": 18, "8007": 34, "8008": 12, "8009": 50, "8010": 30, "8011": 12, "8012": 20, "8013": 25,
    "8017": 18, "8018": 18, "8019": 10, "8020": 25, "8110": 70, "8111": 4, "8112": 70, "8200": 70,
    "90": 30, "91": 90, "92": 90, "93": 90, "94": 90, "95": 90, "96": 90, "97": 90, "98": 90, "99": 90 };
  const NUMERIC = { "00": 1, "01": 1, "02": 1, "03": 1, "11": 1, "12": 1, "13": 1, "15": 1, "16": 1, "17": 1, "20": 1, "30": 1, "37": 1, "242": 1, "402": 1, "7003": 1, "8005": 1 };
  const DATE_AI = { "11": "製造日", "12": "支払期日", "13": "包装日", "15": "品質保持期限", "16": "販売期限", "17": "使用期限" };
  const NAMES = { "01": "GTIN", "17": "使用期限", "10": "LOT", "21": "シリアル", "11": "製造日", "240": "追加識別(REF)", "241": "顧客品番",
    "30": "数量", "20": "バリアント", "90": "社内90", "91": "社内91", "93": "社内93", "00": "SSCC", "02": "内容GTIN", "37": "内容数" };
  // GS1 の AI に使える文字（文字セット 82）
  const CSET82 = /^[!"%&'()*+,\-./0-9:;<=>?_A-Za-z]*$/;
  const GS1_SYM = ["]C1", "]e0", "]d2", "]Q3", "]J1"];   // GS1-128 / GS1 DataBar / GS1 DataMatrix / GS1 QR / GS1 DotCode

  function aiSpec(ai) {
    if (FIXED[ai] !== undefined) return { ai, len: FIXED[ai], max: FIXED[ai] };
    if (VARMAX[ai] !== undefined) return { ai, len: null, max: VARMAX[ai] };
    if (/^3[1-6]\d\d$/.test(ai)) return { ai, len: 6, max: 6, num: true };       // 計量（31nn〜36nn）
    if (/^39[0-5]\d$/.test(ai)) return { ai, len: null, max: 18, num: true };    // 金額など
    if (/^(703|723)\d$/.test(ai)) return { ai, len: null, max: 30 };
    return null;
  }
  function matchAI(s, i) {
    for (const L of [2, 3, 4]) {
      const ai = s.substr(i, L);
      if (ai.length < L || !/^\d+$/.test(ai)) continue;
      const sp = aiSpec(ai); if (sp) return sp;
    }
    return null;
  }
  const isNum = (ai) => !!(NUMERIC[ai] || /^3[1-6]\d\d$/.test(ai) || /^39[0-5]\d$/.test(ai) || /^41[0-6]$/.test(ai));

  // YYMMDD を調べる。DD=00 は「日なし」＝その月の末日（GS1 の決まり）。年は GS1 の世紀の決まり（今年から -49〜+50 年）で 4 桁にする
  function dateInfo(v, nowYear) {
    if (!/^\d{6}$/.test(String(v || ""))) return { ok: false, iso: "", why: "6桁の数字でない" };
    const ny = nowYear || new Date().getFullYear();
    const yy = +v.substr(0, 2), m = +v.substr(2, 2); let d = +v.substr(4, 2);
    let y = Math.floor(ny / 100) * 100 + yy; const diff = yy - (ny % 100);
    if (diff >= 51) y -= 100; else if (diff <= -50) y += 100;
    if (m < 1 || m > 12) return { ok: false, iso: "", why: "月が" + v.substr(2, 2) };
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const noDay = d === 0; if (noDay) d = last;
    if (d > last) return { ok: false, iso: "", why: m + "月" + d + "日は無い" };
    return { ok: true, iso: y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0"), year: y, noDay };
  }
  function expiry(v) { return dateInfo(v).iso; }   // YYMMDD → YYYY-MM-DD（実在しない日付は ""）

  function visible(s) { return [...String(s == null ? "" : s)].map((c) => { const n = c.charCodeAt(0); return n === 29 ? "<GS>" : n === 13 ? "<CR>" : n === 10 ? "<LF>" : n === 9 ? "<TAB>" : n < 32 ? "<0x" + n.toString(16).padStart(2, "0") + ">" : c; }).join(""); }

  // 生文字列（区切りは GS に統一済み）を要素に分ける。errors があっても読めたところまで返す
  function scanRaw(s, add) {
    const els = []; let i = 0;
    while (i < s.length) {
      if (s[i] === GS) { i++; continue; }
      const sp = matchAI(s, i);
      if (!sp) { add("unknown_ai", "error", "未知のAI: " + visible(s.substr(i, 12)), ""); break; }
      i += sp.ai.length; let v, end;
      if (sp.len) { v = s.substr(i, sp.len); i += sp.len; end = "fixed"; const g = v.indexOf(GS); if (g >= 0) { i = i - sp.len + g + 1; v = v.slice(0, g); } }   // 固定長の途中に GS ＝途中で切れている
      else { const j = s.indexOf(GS, i); if (j >= 0) { v = s.substring(i, j); i = j + 1; end = "gs"; } else { v = s.substring(i); i = s.length; end = "eos"; } }
      els.push({ ai: sp.ai, value: v, end, len: sp.len, max: sp.max });
    }
    return els;
  }
  // 括弧付き HRI を要素に分ける（括弧の中が知っている AI のところだけを境界にする）
  function scanHri(s, add) {
    const els = []; const re = /\((\d{2,4})\)/g; const marks = []; let m;
    while ((m = re.exec(s))) { const sp = aiSpec(m[1]); if (sp) marks.push({ sp, at: m.index, next: re.lastIndex }); else if (!marks.length) { add("unknown_ai", "error", "未知のAI: (" + m[1] + ")", ""); return els; } }
    marks.forEach((k, n) => {
      const v = s.substring(k.next, n + 1 < marks.length ? marks[n + 1].at : s.length).replace(/\u001d/g, "").trim();
      els.push({ ai: k.sp.ai, value: v, end: "hri", len: k.sp.len, max: k.sp.max });
    });
    return els;
  }
  function checkElements(els, add, nowYear) {
    const seen = {};
    for (const e of els) {
      const nm = NAMES[e.ai] || "AI(" + e.ai + ")";
      if (e.len && e.value.length !== e.len) add("truncated", "error", nm + "が途中で切れている（" + e.value.length + "/" + e.len + "桁）", e.ai);
      else if (!e.len && !e.value.length) add("empty", "error", nm + "が空", e.ai);
      else if (!e.len && e.value.length > e.max) add("too_long", "error", nm + "が長すぎる（" + e.value.length + "字。上限 " + e.max + "）", e.ai);
      if (isNum(e.ai) ? /\D/.test(e.value) : !CSET82.test(e.value)) add("charset", "error", nm + "に使えない文字: " + visible(e.value).slice(0, 24), e.ai);
      else if (DATE_AI[e.ai] && e.value.length === 6) { const di = dateInfo(e.value, nowYear); if (!di.ok) add("bad_date", "error", DATE_AI[e.ai] + "が実在しない日付（" + e.value + "：" + di.why + "）", e.ai); }
      if (seen[e.ai] !== undefined && seen[e.ai] !== e.value) add("dup", "error", nm + "が2つあり内容が違う", e.ai);
      if (seen[e.ai] === undefined) seen[e.ai] = e.value;
    }
  }
  // GS が無いまま末尾まで読んだ可変長項目の中に「日付の AI ＋ 実在する日付（＋きちんと読める続き）」が埋まっていないか探す。
  // 見つけても自動では採らない（LOT にたまたま同じ並びが入ることがある）。候補として返すだけ
  function findAlts(els, nowYear) {
    const last = els[els.length - 1]; if (!last || last.end !== "eos" || last.len) return [];
    const have = {}; els.forEach((e) => { have[e.ai] = 1; });
    const v = last.value, ny = nowYear || new Date().getFullYear(), out = [];
    for (let k = 1; k + 8 <= v.length; k++) {
      const ai = v.substr(k, 2); if (!DATE_AI[ai] || have[ai]) continue;
      const dv = v.substr(k + 2, 6), di = dateInfo(dv, ny); if (!di.ok) continue;
      if (ai === "17" || ai === "15" || ai === "16") { if (di.year < ny - 3 || di.year > ny + 12) continue; } else if (di.year < ny - 12 || di.year > ny) continue;
      const rest = v.slice(k + 8); let tail = [];
      if (rest) { let bad = false; tail = scanRaw(rest, () => { bad = true; }); if (!bad) checkElements(tail, () => { bad = true; }, ny); if (bad || tail.some((t) => have[t.ai] || t.ai === ai)) continue; }
      const ex = {}; ex[ai] = dv; tail.forEach((t) => { ex[t.ai] = t.value; });
      out.push({ ai: last.ai, value: v.slice(0, k), extra: ex, label: (NAMES[last.ai] || last.ai) + "=" + v.slice(0, k) + " / " + Object.keys(ex).map((a) => (NAMES[a] || "AI" + a) + "=" + (DATE_AI[a] ? dateInfo(ex[a], ny).iso : ex[a])).join(" / ") });
    }
    return out;
  }

  function parse(input, opt) {
    opt = opt || {};
    const rawIn = String(input == null ? "" : input), issues = [];
    const add = (code, level, msg, ai) => { issues.push({ code, level, msg, ai: ai || "" }); };
    const done = (o) => { o.issues = issues; o.warn = issues.filter((x) => x.level !== "info").map((x) => x.msg); o.raw = rawIn; return o; };
    let s = rawIn.replace(/[\r\n\t]+$/, "").replace(/^[ 　]+|[ 　]+$/g, "");
    if (!s) { add("empty_input", "error", "空"); return done({ ok: false, ai: {}, elements: [], form: "", sym: "" }); }
    if (/[！-～]/.test(s)) { s = s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)); add("fullwidth", "warn", "全角で届いた（半角に直した。日本語入力をオフに）"); }
    s = s.replace(/<GS(?::29)?>|[↔␝]/gi, GS);   // 画面表示用の <GS>、Alt+29 で入る ↔ を GS に戻す
    let sym = ""; const m0 = /^\]([A-Za-z][0-9A-Za-z])/.exec(s); if (m0) { sym = "]" + m0[1]; s = s.slice(3); }
    if (sym && GS1_SYM.indexOf(sym) < 0) { add("non_gs1", "info", "GS1 ではないバーコード（" + sym + "）"); return done({ ok: false, nonGs1: true, ai: {}, elements: [], form: "plain", sym, body: s }); }
    let els, form, gsCount = 0;
    if (/^\(\d{2,4}\)/.test(s)) { form = "hri"; els = scanHri(s, add); }
    else {
      form = "raw";
      s = s.replace(/[\u001e\u001f]/g, GS);
      if (/[\^~|]/.test(s)) { s = s.replace(/[\^~|]/g, GS); add("gs_subst", "info", "区切りが記号（^ ~ |）に置き換わって届いた"); }
      s = s.replace(/^\u001d+/, ""); gsCount = (s.match(/\u001d/g) || []).length;
      els = scanRaw(s, add);
    }
    checkElements(els, add, opt.nowYear);
    const ai = {}; els.forEach((e) => { if (ai[e.ai] === undefined) ai[e.ai] = e.value; });
    let alts = [], noGs = false;
    if (form === "raw" && els.length) {
      const last = els[els.length - 1];
      if (last.end === "eos" && !last.len) {
        alts = findAlts(els, opt.nowYear);
        if (alts.length) add("gs_suspect", "error", "GS(区切り)抜けの疑い：" + (NAMES[last.ai] || last.ai) + "の中に日付らしい並び", last.ai);
        else if (gsCount === 0 && els.length > 1) noGs = true;   // GS が 1 つも無い。可変長項目が最後なら正常だが、抜けたのかは文字列だけでは決まらない
      }
    }
    const good = els.filter((e) => !issues.some((x) => x.level === "error" && x.ai === e.ai)).length;
    return done({ ok: els.length > 0 && good > 0, ai, elements: els, form, sym, gsCount, noGs, alts, norm: visible(s) });
  }

  function gtinToJan(g) { return g ? g.replace(/^0+/, "") : ""; }
  // 梱包単位 GTIN-14（先頭 1〜9）→ 単品 GTIN の候補。先頭を 0 にすると末尾のチェックデジットも変わるので計算し直す
  function checkDigit(body) { let s = 0; for (let k = 0; k < body.length; k++) s += (+body[k]) * ((body.length - k) % 2 === 1 ? 3 : 1); return String((10 - s % 10) % 10); }
  function unitGtin(g) { if (!(g && /^\d{14}$/.test(g) && g[0] !== "0")) return g; const body = "0" + g.substr(1, 12); return body + checkDigit(body); }
  function gtinCheck(g) {
    if (!/^\d{14}$/.test(g)) return false;
    let s = 0; for (let k = 0; k < 13; k++) s += (+g[k]) * (k % 2 === 0 ? 3 : 1);
    return (10 - s % 10) % 10 === +g[13];
  }

  // 台帳の 1 行にする。q: "ok"＝検査を通った / "check"＝箱の印字と照らして確かめる
  function toRecord(p, opt) {
    opt = opt || {};
    const a = p.ai || {}; const g = a["01"] || ""; const ny = opt.nowYear || new Date().getFullYear();
    const warn = (p.warn || []).slice(); let q = (p.issues || []).some((x) => x.level === "error") ? "check" : "ok";
    const ex = dateInfo(a["17"] || "", ny), pr = dateInfo(a["11"] || "", ny);
    if (ex.ok && (ex.year > ny + 15 || ex.year < ny - 10)) { warn.push("使用期限の年が不自然（" + ex.year + "年）"); q = "check"; }
    if (pr.ok && pr.iso > new Date().toISOString().slice(0, 10) && !opt.nowYear) { warn.push("製造日が未来（" + pr.iso + "）"); q = "check"; }
    if (ex.ok && pr.ok && ex.iso < pr.iso) { warn.push("使用期限が製造日より前"); q = "check"; }
    const gv = g ? gtinCheck(g) : null; if (gv === false) q = "check";
    return { gtin: g, jan: gtinToJan(unitGtin(g)), lot: a["10"] || "", expiry: ex.iso, expiryRaw: a["17"] || "",
      serial: a["21"] || "", ref: a["240"] || a["241"] || "", prod: pr.iso, gtinValid: gv,
      packLevel: g && g[0] !== "0" ? g[0] : "", warn, raw: p.raw, q, form: p.form || "", sym: p.sym || "", noGs: !!p.noGs,
      alts: (p.alts || []).map((x) => ({ ai: x.ai, value: x.value, extra: x.extra, label: x.label })) };
  }
  // 候補（alts の 1 つ）を行に当てる。元の値は lotScan に残す
  function applyAlt(r, alt) {
    if (!alt) return r;
    if (alt.ai === "10") { r.lotScan = r.lot; r.lot = alt.value; } else if (alt.ai === "21") r.serial = alt.value; else if (alt.ai === "240" || alt.ai === "241") r.ref = alt.value;
    const x = alt.extra || {};
    if (x["17"]) { r.expiryRaw = x["17"]; r.expiry = dateInfo(x["17"]).iso; }
    if (x["11"]) r.prod = dateInfo(x["11"]).iso;
    if (x["21"] && !r.serial) r.serial = x["21"]; if (x["10"] && !r.lot) r.lot = x["10"]; if ((x["240"] || x["241"]) && !r.ref) r.ref = x["240"] || x["241"];
    return r;
  }
  // リーダー確認用のコード（GS1 の見本用の番号。製品ではない）。LOT とシリアルの後ろの GS 2 か所が届くかを見る
  const TEST = { gtin: "09506000134352",
    linear: { label: "GS1-128（一次元）", raw: "010950600013435210TEST128A" + GS + "21SN128B" + GS + "17301231", lot: "TEST128A", serial: "SN128B", exp: "301231" },
    matrix: { label: "GS1 DataMatrix（二次元）", raw: "010950600013435210TESTDMA" + GS + "21SNDMB" + GS + "17301231", lot: "TESTDMA", serial: "SNDMB", exp: "301231" } };
  root.GS1 = { VERSION, parse, expiry, dateInfo, gtinToJan, unitGtin, gtinCheck, checkDigit, toRecord, applyAlt, visible, aiSpec, NAMES, GS, TEST };
  if (typeof module !== "undefined" && module.exports) module.exports = root.GS1;
})(typeof window !== "undefined" ? window : globalThis);
