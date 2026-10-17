(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GoogleTX = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const ENDPOINT = "https://translate.googleapis.com/translate_a/single";

  function splitChunks(text, max) {
    const t = String(text || "");
    if (t.length <= max) return [t];
    const parts = [];
    let buf = "";
    for (const piece of t.split(/(\n+|(?<=[.!?…])\s+)/)) {
      if ((buf + piece).length > max && buf) {
        parts.push(buf);
        buf = piece;
      } else buf += piece;
    }
    if (buf) parts.push(buf);
    return parts.filter((p) => p.length);
  }

  async function googleGet(params) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => usp.append(k, x));
      else usp.set(k, v);
    }
    const url = ENDPOINT + "?" + usp.toString();
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error("Google Translate HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function sentencesText(data) {
    if (!data) return "";
    if (data.sentences) return data.sentences.map((s) => s.trans || "").join("");
    if (Array.isArray(data) && Array.isArray(data[0])) {
      return data[0].map((s) => (s && s[0]) || "").join("");
    }
    return "";
  }

  async function translate(text, sourceLang, targetLang) {
    const raw = String(text || "").trim();
    if (!raw) return { translated: "", engine: "google", alternatives: [] };
    if (sourceLang === targetLang) return { translated: raw, engine: "google", alternatives: [] };
    const chunks = splitChunks(raw, 1400);
    const out = [];
    let alternatives = [];
    for (const chunk of chunks) {
      const data = await googleGet({
        client: "gtx",
        sl: sourceLang || "auto",
        tl: targetLang || "uk",
        dt: ["t", "at"],
        dj: "1",
        q: chunk,
      });
      out.push(sentencesText(data));
      if (!alternatives.length && data.alternative_translations) {
        alternatives = (data.alternative_translations[0]?.alternative || [])
          .map((a) => a.word_postproc)
          .filter(Boolean);
      }
    }
    return { translated: out.join(""), engine: "google", alternatives };
  }

  function lookupFromGoogle(data, word, lang, other) {
    const translation = sentencesText(data) || null;
    const synSet = new Map();
    for (const a of data.alternative_translations || []) {
      for (const w of a.alternative || []) {
        if (w.word_postproc && w.word_postproc.toLowerCase() !== String(word).toLowerCase()) {
          synSet.set(w.word_postproc, { word: w.word_postproc, nuance: lang === "uk" ? "варіант Google" : "вариант Google" });
        }
      }
    }
    for (const d of data.dict || []) {
      for (const term of d.terms || d.entry || []) {
        const w = term.word || term;
        if (typeof w === "string") synSet.set(w, { word: w, nuance: d.pos || "" });
        for (const rt of term.reverse_translation || []) {
          synSet.set(rt, { word: rt, nuance: d.pos || "" });
        }
      }
    }
    for (const s of data.synsets || []) {
      for (const e of s.entry || []) {
        for (const syn of e.synonym || []) {
          synSet.set(syn, { word: syn, nuance: s.pos || "" });
        }
      }
    }
    const senses = [];
    for (const d of data.definitions || []) {
      for (const e of d.entry || []) {
        const examples = [];
        if (e.example) {
          examples.push(lang === "ru" ? { ru: e.example, uk: "" } : { ru: "", uk: e.example });
        }
        senses.push({
          gloss: e.gloss || d.pos || "",
          synonyms: [],
          examples,
          pos: d.pos || "",
        });
      }
    }
    for (const ex of data.examples?.example || []) {
      if (!ex.text) continue;
      const row = { ru: "", uk: "" };
      if (lang === "ru") row.ru = ex.text;
      else row.uk = ex.text;
      if (senses[0]) senses[0].examples.push(row);
      else senses.push({ gloss: "", synonyms: [], examples: [row] });
    }
    const syns = [...synSet.values()].slice(0, 10);
    if (!senses.length) {
      senses.push({
        gloss: translation || "",
        synonyms: syns,
        examples: [],
      });
    } else {
      senses[0].synonyms = [...syns, ...(senses[0].synonyms || [])];
    }
    return {
      word,
      lang,
      translation,
      senses,
      recommended: syns[0]?.word || translation,
      engine: "google",
      other,
    };
  }

  async function lookup(word, sourceLang, targetLang) {
    const w = String(word || "").trim();
    if (!w) return null;
    const sl = sourceLang || "auto";
    const tl = targetLang || (sl === "ru" ? "uk" : "ru");
    const full = await googleGetFull(w, sl, tl);
    return lookupFromGoogle(full, w, sl, tl);
  }

  async function googleGetFull(word, sl, tl) {
    const usp = new URLSearchParams();
    usp.set("client", "gtx");
    usp.set("sl", sl);
    usp.set("tl", tl);
    usp.set("dj", "1");
    usp.append("dt", "t");
    usp.append("dt", "at");
    usp.append("dt", "bd");
    usp.append("dt", "md");
    usp.append("dt", "ss");
    usp.append("dt", "ex");
    usp.set("q", word);
    const url = ENDPOINT + "?" + usp.toString();
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error("Google Translate HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    translate,
    lookup,
    lookupFromGoogle,
    googleGetFull,
    sentencesText,
  };
});
