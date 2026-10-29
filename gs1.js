// GS1 文字列（GS1-128 / GS1 DataMatrix）を AI ごとに分解する。
// 受け付ける形:
//   1) リーダー生出力: "]C1" / "]d2" / "]e0" の先頭記号 + 区切り GS(0x1D) 入り
//   2) 括弧付き HRI: "(01)04547327123624(17)290630(10)260709A10F"
//   3) 区切り無しの生文字列（可変長 AI は末尾まで、または次の既知 AI 候補まで。あいまいさは warn に残す）
(function (root) {
  const GS = "\u001d";
  const FIXED = { "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6, "20": 2,
    "410": 13, "411": 13, "412": 13, "413": 13, "414": 13, "415": 13, "416": 13 };
  const VAR = ["10", "21", "22", "240", "241", "242", "243", "250", "251", "253", "254", "30", "37", "400", "401", "402", "403",
    "420", "421", "422", "423", "424", "425", "426", "710", "711", "712", "713", "714", "715", "7001", "7002", "7003", "7004", "7005", "7006",
    "8001", "8002", "8003", "8004", "8005", "8006", "8007", "8008", "8010", "8011", "8012", "8013", "8017", "8018", "8019", "8020",
    "90", "91", "92", "93", "94", "95", "96", "97", "98", "99"];
  const NAMES = { "01": "GTIN", "17": "使用期限", "10": "LOT", "21": "シリアル", "11": "製造日", "240": "追加識別(REF)", "241": "顧客品番",
    "30": "数量", "20": "バリアント", "90": "社内90", "91": "社内91", "93": "社内93", "00": "SSCC", "02": "内容GTIN", "37": "内容数" };

  function matchAI(s, i) {
    for (const L of [2, 3, 4]) {
      const ai = s.substr(i, L);
      if (ai.length < L) continue;
      if (FIXED[ai] !== undefined) return { ai, len: FIXED[ai] };
      if (VAR.indexOf(ai) >= 0) return { ai, len: null };
    }
    return null;
  }

  // 括弧付き → GS 区切りの生形式に正規化
  function fromHRI(s) {
    if (!/^\(\d{2,4}\)/.test(s)) return null;
    let out = "";
    const re = /\((\d{2,4})\)([^(]*)/g; let m;
    while ((m = re.exec(s))) {
      const ai = m[1], v = m[2];
      out += ai + v;
      if (FIXED[ai] === undefined) out += GS; // 可変長の後ろに GS
    }
    return out;
  }

  function parse(input) {
    let s = String(input || "").trim();
    const warn = [];
    if (!s) return { ok: false, ai: {}, warn: ["空"] };
    const hri = fromHRI(s);
    if (hri) s = hri;
    s = s.replace(/^\](C1|d2|e0|Q3)/, "");
    s = s.replace(/[\u001d\u001e\u001f]/g, GS).replace(/\^|~|\|/g, GS); // ウェッジ設定で GS が ^ や ~ に置換される例に対応
    s = s.replace(/^\u001d+/, "");
    const ai = {}; let i = 0; const hasGS = s.indexOf(GS) >= 0;
    while (i < s.length) {
      if (s[i] === GS) { i++; continue; }
      const m = matchAI(s, i);
      if (!m) { warn.push("未知のAI: " + s.substr(i, 12)); break; }
      i += m.ai.length;
      let v;
      if (m.len) { v = s.substr(i, m.len); i += m.len; if (v.length < m.len) warn.push("AI(" + m.ai + ") が短い"); }
      else {
        const j = s.indexOf(GS, i);
        if (j >= 0) { v = s.substring(i, j); i = j + 1; }
        else { v = s.substring(i); i = s.length; if (!hasGS && Object.keys(ai).length === 0) warn.push("区切り無し: AI(" + m.ai + ") は末尾まで"); }
      }
      if (ai[m.ai] !== undefined && ai[m.ai] !== v) warn.push("AI(" + m.ai + ") 重複");
      ai[m.ai] = v;
    }
    return { ok: Object.keys(ai).length > 0, ai, warn, raw: input };
  }

  function expiry(v) { // YYMMDD → YYYY-MM-DD（DD=00 は月末）
    if (!v || v.length !== 6 || !/^\d{6}$/.test(v)) return "";
    let y = 2000 + +v.substr(0, 2), m = +v.substr(2, 2), d = +v.substr(4, 2);
    if (m < 1 || m > 12) return "";
    if (d === 0) d = new Date(y, m, 0).getDate();
    return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }
  function gtinToJan(g) { return g ? g.replace(/^0+/, "") : ""; }
  // 梱包単位 GTIN-14（先頭 1〜8）→ 単品 GTIN の候補
  function unitGtin(g) { return g && g.length === 14 && g[0] !== "0" ? "0" + g.substr(1) : g; }
  function gtinCheck(g) {
    if (!/^\d{14}$/.test(g)) return false;
    let s = 0; for (let k = 0; k < 13; k++) s += (+g[k]) * (k % 2 === 0 ? 3 : 1);
    return (10 - s % 10) % 10 === +g[13];
  }

  function toRecord(p) {
    const a = p.ai; const g = a["01"] || "";
    return { gtin: g, jan: gtinToJan(unitGtin(g)), lot: a["10"] || "", expiry: expiry(a["17"] || ""), expiryRaw: a["17"] || "",
      serial: a["21"] || "", ref: a["240"] || a["241"] || "", prod: expiry(a["11"] || ""), gtinValid: g ? gtinCheck(g) : null,
      packLevel: g && g[0] !== "0" ? g[0] : "", warn: p.warn.slice(), raw: p.raw };
  }
  root.GS1 = { parse, expiry, gtinToJan, unitGtin, gtinCheck, toRecord, NAMES, GS };
})(typeof window !== "undefined" ? window : globalThis);
