"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const GoogleTX = require("./public/google.js");

const PORT = Number(process.env.PEREGOVORY_PORT || 8765);
const HOST = process.env.PEREGOVORY_HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const WS_DIR = path.join(DATA_DIR, "ws");
const ROOMS_DIR = path.join(DATA_DIR, "rooms");
const PRESENCE_DIR = path.join(DATA_DIR, "presence");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const PUBLIC_URL_PATH = path.join(DATA_DIR, "public-url.txt");
const PRESENCE_TTL_MS = 18000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

const fileLocks = new Map();
function withLock(key, fn) {
  const run = () => Promise.resolve().then(fn);
  const prev = fileLocks.get(key) || Promise.resolve();
  const next = prev.then(run, run);
  fileLocks.set(key, next.catch(() => {}));
  return next;
}

function mergeById(a, b, pick) {
  const map = new Map();
  for (const item of a || []) {
    if (item && item.id) map.set(item.id, item);
  }
  for (const item of b || []) {
    if (!item || !item.id) continue;
    const cur = map.get(item.id);
    map.set(item.id, cur ? pick(cur, item) : item);
  }
  return [...map.values()];
}

function richerText(a, b) {
  const at = String(a || "");
  const bt = String(b || "");
  return bt.length >= at.length ? b : a;
}

function mergeMessages(a, b, deletedIds) {
  const del = new Set(deletedIds || []);
  const merged = mergeById(a, b, (cur, inc) => ({
    ...cur,
    ...inc,
    original: richerText(cur.original, inc.original),
    translated: richerText(cur.translated, inc.translated),
    createdAt: cur.createdAt && inc.createdAt && cur.createdAt < inc.createdAt ? cur.createdAt : inc.createdAt || cur.createdAt,
  }));
  return merged
    .filter((m) => m && m.id && !del.has(m.id))
    .sort((x, y) => String(x.createdAt || "").localeCompare(String(y.createdAt || "")));
}

function mergeGlossary(a, b) {
  const byId = mergeById(a, b, (cur, inc) => ({ ...cur, ...inc }));
  const seen = new Set();
  const out = [];
  for (const g of byId) {
    const key = `${keyWord(g.src)}|${keyWord(g.tgt)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

function laterStamp(a, b) {
  return String(b || "") >= String(a || "") ? b : a;
}

function mergeSession(base, incoming) {
  if (!incoming) return base;
  if (!base) return incoming;
  const deletedIds = [...new Set([...(base.deletedIds || []), ...(incoming.deletedIds || [])])];
  const baseT = String(base.updatedAt || base.createdAt || "");
  const incT = String(incoming.updatedAt || incoming.createdAt || "");
  const newer = incT >= baseT ? incoming : base;
  const older = newer === incoming ? base : incoming;
  return {
    ...older,
    ...newer,
    id: incoming.id || base.id,
    title: (newer.title && String(newer.title).trim()) || older.title || "",
    notes: newer.notes != null && String(newer.notes).length >= String(older.notes || "").length ? newer.notes : older.notes || "",
    sourceLang: newer.sourceLang || older.sourceLang,
    targetLang: newer.targetLang || older.targetLang,
    glossary: mergeGlossary(base.glossary, incoming.glossary),
    messages: mergeMessages(base.messages, incoming.messages, deletedIds),
    deletedIds,
    public: Boolean(base.public || incoming.public),
    watchCode: String(base.watchCode || incoming.watchCode || "").toUpperCase(),
    updatedAt: laterStamp(base.updatedAt, incoming.updatedAt) || nowIso(),
    createdAt: base.createdAt || incoming.createdAt,
  };
}

const CODE_ALPH = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function normCode(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function makeWatchCode() {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_ALPH[Math.floor(Math.random() * CODE_ALPH.length)];
  return s;
}

function usedWatchCodes(exceptId) {
  const used = new Set();
  for (const r of listRoomSessions()) {
    if (!r || r.id === exceptId) continue;
    const c = normCode(r.watchCode);
    if (c) used.add(c);
  }
  return used;
}

function ensureWatchCode(room) {
  if (!room) return room;
  let code = normCode(room.watchCode);
  const used = usedWatchCodes(room.id);
  if (code.length === 4 && !used.has(code)) {
    room.watchCode = code;
    return room;
  }
  do {
    code = makeWatchCode();
  } while (used.has(code));
  room.watchCode = code;
  return room;
}

function originBase() {
  return (publicUrl() || `http://127.0.0.1:${PORT}`).replace(/\/$/, "").split("?")[0];
}

function roomLinks(room) {
  const base = originBase();
  const id = encodeURIComponent(room.id);
  const code = normCode(room.watchCode);
  const watch = code ? `${base}/watch/${code}` : `${base}/watch.html?room=${id}`;
  return {
    share: `${base}/results.html?room=${id}`,
    watch,
    watchLong: `${base}/watch.html?room=${id}`,
    watchCode: code,
    lanWatch: lanAddresses().map((ip) =>
      code ? `http://${ip}:${PORT}/watch/${code}` : `http://${ip}:${PORT}/watch.html?room=${id}`
    ),
    localWatch: code ? `http://127.0.0.1:${PORT}/watch/${code}` : `http://127.0.0.1:${PORT}/watch.html?room=${id}`,
  };
}

function decorateRoom(room) {
  if (!room) return room;
  const before = room.watchCode;
  ensureWatchCode(room);
  if (room.watchCode !== before) {
    try {
      writeJson(roomFile(room.id), room);
    } catch {
      /* still return the code this request */
    }
  }
  return room;
}

function findRoomByCode(code) {
  const c = normCode(code);
  if (!c) return null;
  const byId =
    readJson(roomFile(code), null) ||
    readJson(roomFile(c), null) ||
    readJson(roomFile(c.toLowerCase()), null);
  if (byId) return decorateRoom(byId);
  for (const r of listRoomSessions()) {
    if (normCode(r.watchCode) === c) return decorateRoom(r);
  }
  return null;
}

function presenceFile(id) {
  return path.join(PRESENCE_DIR, safeId(id) + ".json");
}

function prunePresence(all) {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  const live = {};
  for (const [id, p] of Object.entries(all || {})) {
    if (!p || !p.seenAt) continue;
    const t = Date.parse(p.seenAt);
    if (Number.isFinite(t) && t >= cutoff) live[id] = p;
  }
  return live;
}

function listPeople(roomId) {
  const live = prunePresence(readJson(presenceFile(roomId), {}));
  return Object.values(live).sort((a, b) => String(a.seenAt).localeCompare(String(b.seenAt)));
}

function beatPresence(roomId, clientId, body = {}) {
  fs.mkdirSync(PRESENCE_DIR, { recursive: true });
  const all = prunePresence(readJson(presenceFile(roomId), {}));
  const speaker = body.speaker === "them" ? "them" : body.speaker === "view" ? "view" : "me";
  all[clientId] = {
    id: clientId,
    speaker,
    uiLang: body.uiLang === "uk" ? "uk" : "ru",
    seenAt: nowIso(),
  };
  writeJson(presenceFile(roomId), all);
  return Object.values(all);
}

function tableHealth(people) {
  const n = (people || []).length;
  if (n >= 2) return { status: "great", label: "great" };
  if (n === 1) return { status: "ok", label: "ok" };
  return { status: "ok", label: "ready" };
}

function saveRoomMerged(id, incoming) {
  fs.mkdirSync(ROOMS_DIR, { recursive: true });
  const file = roomFile(id);
  const existing = readJson(file, null);
  const merged = mergeSession(existing, incoming);
  merged.id = safeId(id);
  merged.updatedAt = nowIso();
  merged.public = true;
  ensureWatchCode(merged);
  writeJson(file, merged);
  return merged;
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const lexiconFile = readJson(path.join(ROOT, "dict", "lexicon.json"), { ru_uk: {} });
const phrases = readJson(path.join(ROOT, "dict", "phrases.json"), []);
const synonymsFile = readJson(path.join(ROOT, "dict", "synonyms.json"), { entries: [] });

const ruUk = { ...lexiconFile.ru_uk };
const ukRu = {};
for (const [ru, uk] of Object.entries(ruUk)) {
  if (uk && !ukRu[uk.toLowerCase()]) ukRu[uk.toLowerCase()] = ru;
}

const phraseRu = new Map();
const phraseUk = new Map();
for (const p of phrases) {
  if (p.ru && p.uk) {
    phraseRu.set(normText(p.ru), p.uk);
    phraseUk.set(normText(p.uk), p.ru);
  }
}

const synIndex = new Map();
for (const entry of synonymsFile.entries || []) {
  for (const lang of ["ru", "uk"]) {
    for (const head of entry.heads?.[lang] || []) {
      synIndex.set(keyWord(head) + "|" + lang, entry);
    }
    for (const sense of entry.senses || []) {
      for (const s of sense.syn?.[lang] || []) {
        const k = keyWord(s.w) + "|" + lang;
        if (!synIndex.has(k)) synIndex.set(k, entry);
      }
    }
  }
}

function defaultSettings() {
  return {
    uiLang: "ru",
    theme: "paper",
    sourceLang: "ru",
    targetLang: "uk",
    xaiKey: "",
    fontScale: 1,
  };
}

function safeId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "anon";
}

function wsFile(ws) {
  return path.join(WS_DIR, safeId(ws) + ".json");
}

function roomFile(id) {
  return path.join(ROOMS_DIR, safeId(id) + ".json");
}

function listRoomSessions() {
  fs.mkdirSync(ROOMS_DIR, { recursive: true });
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(ROOMS_DIR);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const room = readJson(path.join(ROOMS_DIR, name), null);
    if (!room || typeof room !== "object") continue;
    if (!room.id) room.id = path.basename(name, ".json");
    out.push(room);
  }
  return out;
}

function mergeStores(workspaceStore) {
  const map = new Map();
  for (const s of workspaceStore.sessions || []) {
    if (s && s.id) map.set(s.id, s);
  }
  for (const r of listRoomSessions()) {
    const cur = map.get(r.id);
    map.set(r.id, cur ? mergeSession(cur, r) : r);
  }
  const sessions = [...map.values()].sort((a, b) =>
    String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))
  );
  let currentId = workspaceStore.currentId;
  if (!sessions.some((s) => s.id === currentId)) currentId = sessions[0]?.id || "";
  return { currentId, sessions };
}

function upsertWorkspaceSession(ws, ses) {
  if (!ses || !ses.id) return;
  const store = loadStore(ws);
  const i = store.sessions.findIndex((s) => s.id === ses.id);
  if (i >= 0) store.sessions[i] = mergeSession(store.sessions[i], ses);
  else store.sessions.unshift(ses);
  store.currentId = ses.id;
  saveStore(ws, store);
  return store;
}

function lanAddresses() {
  const os = require("os");
  const out = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) out.push(n.address);
    }
  }
  return out;
}

function publicUrl() {
  try {
    const t = fs.readFileSync(PUBLIC_URL_PATH, "utf8").trim();
    if (t.startsWith("http")) return t.split(/\s+/)[0];
  } catch {
    /* none yet */
  }
  return "";
}

function defaultStore() {
  const id = uid("ses");
  const t = nowIso();
  return {
    currentId: id,
    sessions: [
      {
        id,
        title: "",
        createdAt: t,
        updatedAt: t,
        sourceLang: "ru",
        targetLang: "uk",
        notes: "",
        glossary: [],
        messages: [],
      },
    ],
  };
}

function loadSettings(ws) {
  const pack = loadWorkspace(ws);
  const s = { ...defaultSettings(), ...(pack.settings || {}) };
  if (!s.xaiKey && process.env.XAI_API_KEY) s.xaiKey = process.env.XAI_API_KEY;
  return s;
}

function loadWorkspace(ws) {
  fs.mkdirSync(WS_DIR, { recursive: true });
  const p = wsFile(ws);
  let raw = readJson(p, null);
  if (!raw || !Array.isArray(raw.sessions)) {
    if ((!ws || ws === "anon") && fs.existsSync(STORE_PATH)) {
      const legacy = readJson(STORE_PATH, null);
      if (legacy && Array.isArray(legacy.sessions) && legacy.sessions.length) {
        raw = {
          settings: { ...defaultSettings(), ...readJson(SETTINGS_PATH, {}) },
          currentId: legacy.currentId,
          sessions: legacy.sessions,
        };
        writeJson(p, raw);
        return raw;
      }
    }
    raw = { settings: defaultSettings(), ...defaultStore() };
    writeJson(p, raw);
  }
  if (!raw.settings) raw.settings = defaultSettings();
  if (!raw.currentId || !raw.sessions.some((x) => x.id === raw.currentId)) {
    raw.currentId = raw.sessions[0]?.id || "";
  }
  return raw;
}

function saveWorkspace(ws, pack) {
  fs.mkdirSync(WS_DIR, { recursive: true });
  writeJson(wsFile(ws), pack);
}

function loadStore(ws) {
  const pack = loadWorkspace(ws);
  return { currentId: pack.currentId, sessions: pack.sessions };
}

function saveStore(ws, store) {
  const pack = loadWorkspace(ws);
  pack.currentId = store.currentId;
  pack.sessions = store.sessions;
  saveWorkspace(ws, pack);
}

function publicSettings(s) {
  return {
    uiLang: s.uiLang,
    theme: s.theme,
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    fontScale: s.fontScale,
    hasXai: Boolean(s.xaiKey),
  };
}

function normText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
}

function keyWord(s) {
  return normText(s).replace(/[«»""„".,!?:;()[\]{}]/g, "");
}

const SUFFIXES = [
  "ами", "ями", "ого", "ому", "ыми", "ими", "ами",
  "ою", "ею", "ой", "ей", "ів", "їв", "ах", "ях",
  "ом", "ем", "ам", "ям", "ую", "юю", "ая", "яя",
  "ие", "ые", "ий", "ый", "ій", "ої", "ою",
  "ти", "ть", "ти", "сь", "ся",
  "а", "я", "у", "ю", "е", "є", "и", "і", "ы", "о", "й",
];

function stems(word) {
  const w = keyWord(word);
  const out = new Set([w]);
  if (w.length < 4) return [...out];
  for (const s of SUFFIXES) {
    if (w.endsWith(s) && w.length - s.length >= 3) out.add(w.slice(0, -s.length));
  }
  return [...out];
}

function detectLang(text) {
  const t = String(text || "");
  const uk = (t.match(/[іІїЇєЄґҐ]/g) || []).length;
  const ru = (t.match(/[ыЫэЭъЪёЁ]/g) || []).length;
  if (uk > ru) return "uk";
  if (ru > uk) return "ru";
  return null;
}

function applyGlossary(text, glossary, from, to) {
  let out = text;
  const items = [...(glossary || [])].sort((a, b) => (b.src || "").length - (a.src || "").length);
  for (const g of items) {
    if (!g.src || !g.tgt) continue;
    const src = from === "ru" ? g.ru || g.src : g.uk || g.src;
    const tgt = to === "uk" ? g.uk || g.tgt : g.ru || g.tgt;
    if (!src || !tgt) continue;
    const re = new RegExp(`(?<![\\p{L}])${escapeRe(src)}(?![\\p{L}])`, "giu");
    out = out.replace(re, tgt);
  }
  return out;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localTranslate(text, sourceLang, targetLang, glossary) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (sourceLang === targetLang) return raw;

  const n = normText(raw);
  if (sourceLang === "ru" && targetLang === "uk" && phraseRu.has(n)) return phraseRu.get(n);
  if (sourceLang === "uk" && targetLang === "ru" && phraseUk.has(n)) return phraseUk.get(n);

  let work = applyGlossary(raw, glossary, sourceLang, targetLang);

  const dict = sourceLang === "ru" ? ruUk : ukRu;
  const parts = work.split(/(\n+)/);
  const translated = parts.map((part) => {
    if (/^\n+$/.test(part)) return part;
    return part.replace(/[\p{L}''’-]+/gu, (word) => {
      const lower = word.toLowerCase();
      const nrm = keyWord(lower);
      let hit = dict[nrm] || dict[lower];
      if (!hit) {
        for (const st of stems(nrm)) {
          if (dict[st]) {
            hit = dict[st];
            break;
          }
        }
      }
      if (!hit) return word;
      return matchCase(word, hit);
    });
  });
  return translated.join("");
}

function matchCase(src, tgt) {
  if (src.toUpperCase() === src && src.length > 1) return tgt.toUpperCase();
  if (src[0] && src[0] === src[0].toUpperCase()) {
    return tgt.charAt(0).toUpperCase() + tgt.slice(1);
  }
  return tgt;
}

async function xaiChat(key, messages, temperature = 0.2) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-4.5",
        temperature,
        messages,
      }),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body.error?.message || body.error || res.statusText;
      throw new Error(String(msg));
    }
    return (body.choices?.[0]?.message?.content || "").trim();
  } finally {
    clearTimeout(timer);
  }
}

async function mymemoryTranslate(text, sourceLang, targetLang) {
  const url =
    "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(text.slice(0, 500)) +
    "&langpair=" +
    encodeURIComponent(`${sourceLang}|${targetLang}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json();
    const t = data?.responseData?.translatedText;
    if (t && !/INVALID|QUERY LENGTH/i.test(t)) return t;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sessionContext(session) {
  const last = (session.messages || []).slice(-12);
  const hist = last
    .map((m) => {
      const who = m.speaker === "them" ? "Співрозмовник/Собеседник" : "Ми/Мы";
      return `${who}:\n${m.sourceLang}: ${m.original}\n${m.targetLang}: ${m.translated}`;
    })
    .join("\n\n");
  const gloss = (session.glossary || [])
    .map((g) => `${g.src} → ${g.tgt}${g.note ? " (" + g.note + ")" : ""}`)
    .join("; ");
  return { hist, gloss, notes: session.notes || "" };
}

async function translateText({ text, sourceLang, targetLang, session, settings }) {
  const src = sourceLang || settings.sourceLang || "ru";
  const tgt = targetLang || settings.targetLang || "uk";
  const raw = String(text || "").trim();
  if (!raw) return { translated: "", engine: "empty", sourceLang: src, targetLang: tgt };

  const local = localTranslate(raw, src, tgt, session?.glossary);

  try {
    const g = await GoogleTX.translate(raw, src, tgt);
    if (g.translated) {
      const patched = applyGlossary(g.translated, session?.glossary, src, tgt);
      return { translated: patched, engine: "google", sourceLang: src, targetLang: tgt };
    }
  } catch (err) {
    console.error("Google translate:", err.message);
  }

  if (settings.xaiKey) {
    try {
      const ctx = session ? sessionContext(session) : { hist: "", gloss: "", notes: "" };
      const langName = { ru: "русский", uk: "украинский" };
      const content = await xaiChat(settings.xaiKey, [
        {
          role: "system",
          content:
            "Ты профессиональный синхронный переводчик деловых переговоров RU↔UK. " +
            "Переводи точно по смыслу, сохраняй тон (мягкий/жёсткий), форму вежливости, цифры, имена, даты. " +
            "Не добавляй пояснений. Верни только перевод. " +
            "Если в глоссарии есть термин — используй его. " +
            "Учитывай контекст предыдущих реплик, чтобы местоимения и договорённости звучали последовательно.",
        },
        {
          role: "user",
          content:
            `Направление: ${langName[src]} → ${langName[tgt]}\n` +
            (ctx.notes ? `Контекст переговоров: ${ctx.notes}\n` : "") +
            (ctx.gloss ? `Глоссарий: ${ctx.gloss}\n` : "") +
            (ctx.hist ? `Предыдущие реплики:\n${ctx.hist}\n\n` : "") +
            `Текст для перевода:\n${raw}`,
        },
      ]);
      if (content) return { translated: content, engine: "spacexai", sourceLang: src, targetLang: tgt };
    } catch (err) {
      console.error("xAI translate:", err.message);
    }
  }

  if (phraseRu.has(normText(raw)) || phraseUk.has(normText(raw))) {
    return { translated: local, engine: "memory", sourceLang: src, targetLang: tgt };
  }

  const remote = await mymemoryTranslate(raw, src, tgt);
  if (remote) {
    const patched = applyGlossary(remote, session?.glossary, src, tgt);
    return { translated: patched, engine: "mymemory", sourceLang: src, targetLang: tgt };
  }

  return { translated: local || raw, engine: "local", sourceLang: src, targetLang: tgt };
}

function lookupSynonyms(word, lang) {
  const keys = stems(word).flatMap((st) => [st + "|" + lang, st + "|" + (lang === "ru" ? "uk" : "ru")]);
  keys.unshift(keyWord(word) + "|" + lang);
  let entry = null;
  for (const k of keys) {
    if (synIndex.has(k)) {
      entry = synIndex.get(k);
      break;
    }
  }
  if (!entry) {
    const st = keyWord(word);
    if (st.length >= 4) {
      for (const [k, e] of synIndex) {
        const bar = k.lastIndexOf("|");
        const w = k.slice(0, bar);
        const l = k.slice(bar + 1);
        if (l !== lang) continue;
        if (w.startsWith(st) || st.startsWith(w) || stems(w).some((x) => x === st || st.startsWith(x))) {
          entry = e;
          break;
        }
      }
    }
  }
  if (!entry) return null;
  return {
    heads: entry.heads,
    senses: entry.senses,
  };
}

function localInspect(word, sentence, lang) {
  const found = lookupSynonyms(word, lang);
  const other = lang === "ru" ? "uk" : "ru";
  const dict = lang === "ru" ? ruUk : ukRu;
  const nrm = keyWord(word);
  const direct = dict[nrm];
  if (!found) {
    return {
      word,
      lang,
      translation: direct || null,
      senses: direct
        ? [
            {
              gloss: direct,
              synonyms: [],
              examples: [],
            },
          ]
        : [],
      recommended: null,
    };
  }
  const senses = (found.senses || []).map((s) => ({
    gloss: s[lang] || s.ru || s.uk,
    synonyms: (s.syn?.[lang] || []).map((x) => ({
      word: x.w,
      nuance: x.n,
      other: (s.syn?.[other] || []).find((y) => y.n === x.n)?.w,
    })),
    examples: (s.ex || []).map((e) => ({ ru: e.ru, uk: e.uk })),
  }));
  return {
    word,
    lang,
    translation: direct || found.heads?.[other]?.[0] || null,
    senses,
    recommended: senses[0]?.synonyms?.[0]?.word || null,
  };
}

function mergeInspect(base, google) {
  if (!google) return base;
  const senses = [...(google.senses || [])];
  for (const s of base.senses || []) {
    const exists = senses.some((x) => x.gloss && s.gloss && x.gloss === s.gloss);
    if (!exists) senses.push(s);
  }
  if (senses[0] && (base.senses?.[0]?.synonyms || []).length) {
    const have = new Set((senses[0].synonyms || []).map((x) => x.word));
    for (const syn of base.senses[0].synonyms) {
      if (!have.has(syn.word)) senses[0].synonyms.push(syn);
    }
  }
  return {
    ...base,
    translation: google.translation || base.translation,
    senses: senses.length ? senses : base.senses,
    recommended: google.recommended || base.recommended,
    engine: "google",
  };
}

async function inspectWord({ word, sentence, lang, session, settings, targetLang }) {
  const base = localInspect(word, sentence, lang);
  const tl = targetLang || (lang === "ru" ? "uk" : "ru");
  try {
    const g = await GoogleTX.lookup(word, lang, tl);
    const merged = mergeInspect(base, g);
    if (!settings.xaiKey) return merged;
    base.senses = merged.senses;
    base.translation = merged.translation;
  } catch (err) {
    console.error("Google inspect:", err.message);
    if (!settings.xaiKey) return { ...base, engine: base.senses?.length ? "local" : "local" };
  }
  try {
    const ctx = session ? sessionContext(session) : { hist: "", gloss: "", notes: "" };
    const raw = await xaiChat(
      settings.xaiKey,
      [
        {
          role: "system",
          content:
            "Ты лексикограф-переводчик RU↔UK для деловых переговоров. " +
            "Верни строго JSON без markdown: " +
            '{"translation":"","senses":[{"gloss":"","synonyms":[{"word":"","nuance":""}],"examples":[{"ru":"","uk":""}]}],"recommended":"","why":""}. ' +
            "Синонимы — 4–6 штук с нюансом (когда уместно в переговорах). Примеры — короткие деловые фразы. " +
            "recommended — лучшее слово в ДАННОМ предложении.",
        },
        {
          role: "user",
          content:
            `Язык слова: ${lang}\nСлово: ${word}\nПредложение: ${sentence || "—"}\n` +
            (ctx.notes ? `Контекст: ${ctx.notes}\n` : "") +
            (ctx.hist ? `Недавние реплики:\n${ctx.hist}` : ""),
        },
      ],
      0.3
    );
    const jsonText = raw.replace(/^```json\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(jsonText);
    return {
      word,
      lang,
      translation: parsed.translation || base.translation,
      senses: parsed.senses?.length ? parsed.senses : base.senses,
      recommended: parsed.recommended || base.recommended,
      why: parsed.why || "",
      engine: "spacexai",
    };
  } catch (err) {
    console.error("xAI inspect:", err.message);
    return { ...base, engine: "local" };
  }
}

function findSession(store, id) {
  return store.sessions.find((s) => s.id === id);
}

function findOrImportSession(store, id) {
  let ses = findSession(store, id);
  if (ses) return ses;
  const room = readJson(roomFile(id), null);
  if (!room) return null;
  store.sessions.unshift(room);
  return room;
}

function sessionTitle(session) {
  if (session.title && session.title.trim()) return session.title.trim();
  const first = (session.messages || []).find((m) => m.original && m.original.trim());
  if (first) {
    const t = first.original.trim().replace(/\s+/g, " ");
    return t.length > 42 ? t.slice(0, 42) + "…" : t;
  }
  return "";
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function sendText(res, code, text, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(text);
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  if (rel === "/watch" || rel === "/watch/") rel = "/watch.html";
  if (/^\/watch\/[A-Za-z0-9_-]+$/.test(rel)) rel = "/watch.html";
  const posix = path.posix.normalize(rel).replace(/^(\.\.(\/|$))+/, "");
  let file;
  if (posix.startsWith("/dict/")) {
    file = path.join(ROOT, posix.slice(1));
    if (!path.resolve(file).startsWith(path.resolve(ROOT, "dict"))) {
      sendText(res, 403, "Forbidden");
      return;
    }
  } else {
    file = path.join(PUBLIC, posix);
    if (!path.resolve(file).startsWith(path.resolve(PUBLIC))) {
      sendText(res, 403, "Forbidden");
      return;
    }
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      sendText(res, 404, "Not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON");
  }
}

function exportSession(session, fmt) {
  const title = sessionTitle(session) || "Переговори";
  const lines = [];
  lines.push(title);
  lines.push((session.createdAt || "").slice(0, 16).replace("T", " "));
  if (session.notes) {
    lines.push("");
    lines.push("КОНТЕКСТ / КОНТЕКСТ");
    lines.push(session.notes);
  }
  if (session.glossary?.length) {
    lines.push("");
    lines.push("ГЛОСАРІЙ / ГЛОССАРИЙ");
    for (const g of session.glossary) lines.push(`• ${g.src} → ${g.tgt}${g.note ? " — " + g.note : ""}`);
  }
  lines.push("");
  lines.push("ПРОТОКОЛ");
  for (const m of session.messages || []) {
    const who = m.speaker === "them" ? "Співрозмовник / Собеседник" : "Ми / Мы";
    const t = (m.createdAt || "").slice(11, 16);
    lines.push("");
    lines.push(`— ${who} ${t}`);
    lines.push(`[${(m.sourceLang || "src").toUpperCase()}] ${m.original}`);
    lines.push(`[${(m.targetLang || "tgt").toUpperCase()}] ${m.translated}`);
  }
  const text = lines.join("\n");
  if (fmt === "html") {
    const esc = (s) =>
      String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:Segoe UI,sans-serif;max-width:820px;margin:40px auto;color:#1c2430;line-height:1.45}
h1{font-size:22px} .pair{border:1px solid #d5dde6;border-radius:12px;padding:12px 16px;margin:12px 0}
.who{color:#5c6b7a;font-size:12px} .o{margin:6px 0 2px} .t{color:#1f4e79}</style></head><body>
<h1>${esc(title)}</h1><pre>${esc(text)}</pre></body></html>`;
  }
  return text;
}

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  const ws = safeId(url.searchParams.get("ws") || "anon");

  if (method === "GET" && p === "/api/info") {
    const lan = lanAddresses();
    const base = originBase();
    sendJson(res, 200, {
      publicUrl: publicUrl() ? base : "",
      liveUrl: `${base}/watch.html?room=main`,
      watchUrl: `${base}/watch.html?room=main`,
      lan: lan.map((ip) => `http://${ip}:${PORT}/watch.html?room=main`),
      lanWatch: lan.map((ip) => `http://${ip}:${PORT}/watch`),
      local: `http://127.0.0.1:${PORT}/watch.html?room=main`,
      localWatch: `http://127.0.0.1:${PORT}/watch`,
      google: true,
    });
    return;
  }

  if (method === "GET" && p === "/api/watch") {
    const code = url.searchParams.get("code") || url.searchParams.get("c") || "";
    const roomId = url.searchParams.get("room") || "";
    let room = null;
    if (roomId) room = readJson(roomFile(roomId), null);
    if (!room && code) room = findRoomByCode(code);
    if (!room) return sendJson(res, 404, { error: "Стол не найден" });
    room = decorateRoom(room);
    const people = listPeople(room.id);
    sendJson(res, 200, {
      session: room,
      people,
      health: tableHealth(people),
      ...roomLinks(room),
    });
    return;
  }

  const roomGet = p.match(/^\/api\/rooms\/([^/]+)$/);
  if (roomGet && method === "GET") {
    const people = listPeople(roomGet[1]);
    const id = safeId(roomGet[1]);
    fs.mkdirSync(ROOMS_DIR, { recursive: true });
    let room = readJson(roomFile(id), null);
    if (!room) {
      const t = nowIso();
      room = {
        id,
        title: id === "main" ? "Публичная сессия / Публічна сесія" : "",
        createdAt: t,
        updatedAt: t,
        sourceLang: "ru",
        targetLang: "uk",
        notes: "",
        glossary: [],
        messages: [],
        public: true,
      };
      writeJson(roomFile(id), room);
    }
    room = decorateRoom(room);
    sendJson(res, 200, {
      session: room,
      people,
      health: tableHealth(people),
      ...roomLinks(room),
    });
    return;
  }
  if (roomGet && (method === "POST" || method === "PUT")) {
    const body = await readBody(req);
    const ses = body.session || body;
    if (!ses || !ses.id) return sendJson(res, 400, { error: "Нет сессии" });
    const saved = await withLock("room:" + roomGet[1], () => saveRoomMerged(roomGet[1], ses));
    upsertWorkspaceSession(ws, saved);
    const people = listPeople(roomGet[1]);
    sendJson(res, 200, {
      session: saved,
      people,
      health: tableHealth(people),
      ...roomLinks(saved),
    });
    return;
  }

  const roomPresence = p.match(/^\/api\/rooms\/([^/]+)\/presence$/);
  if (roomPresence && (method === "POST" || method === "GET")) {
    const id = roomPresence[1];
    let people;
    if (method === "POST") {
      const body = await readBody(req);
      people = await withLock("presence:" + id, () => beatPresence(id, ws, body));
    } else {
      people = listPeople(id);
    }
    sendJson(res, 200, { people, health: tableHealth(people) });
    return;
  }

  const roomMsg = p.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  if (roomMsg && method === "POST") {
    const body = await readBody(req);
    const original = String(body.original || "").trim();
    if (!original) return sendJson(res, 400, { error: "Пустой текст" });
    const settings = loadSettings(ws);
    const id = safeId(roomMsg[1]);
    const roomSnap = readJson(roomFile(id), null);
    const sourceLang = body.sourceLang || roomSnap?.sourceLang || settings.sourceLang || "ru";
    const targetLang = body.targetLang || roomSnap?.targetLang || settings.targetLang || "uk";
    let translated = body.translated;
    let engine = body.engine || "given";
    if (!translated) {
      const tr = await translateText({
        text: original,
        sourceLang,
        targetLang,
        session: roomSnap,
        settings,
      });
      translated = tr.translated;
      engine = tr.engine;
    }
    const msg = {
      id: body.id || uid("msg"),
      speaker: body.speaker === "them" ? "them" : "me",
      sourceLang,
      targetLang,
      original,
      translated: String(translated || "").trim(),
      engine,
      createdAt: body.createdAt || nowIso(),
    };
    const saved = await withLock("room:" + id, () => {
      let room = readJson(roomFile(id), null);
      if (!room) {
        room = {
          id,
          title: "",
          createdAt: nowIso(),
          updatedAt: nowIso(),
          sourceLang,
          targetLang,
          notes: "",
          glossary: [],
          messages: [],
          public: true,
        };
      }
      if (!(room.messages || []).some((m) => m.id === msg.id)) {
        room.messages = [...(room.messages || []), msg];
      }
      room.updatedAt = nowIso();
      if (!room.title) room.title = sessionTitle(room);
      writeJson(roomFile(id), room);
      return { room, message: msg };
    });
    upsertWorkspaceSession(ws, saved.room);
    const people = listPeople(id);
    sendJson(res, 200, {
      message: saved.message,
      session: saved.room,
      people,
      health: tableHealth(people),
    });
    return;
  }

  if (method === "GET" && p === "/api/rooms") {
    const rooms = listRoomSessions().sort((a, b) =>
      String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))
    );
    sendJson(res, 200, { rooms });
    return;
  }

  if (method === "POST" && p === "/api/rooms") {
    fs.mkdirSync(ROOMS_DIR, { recursive: true });
    const body = await readBody(req);
    const ses = body.session;
    if (!ses) return sendJson(res, 400, { error: "Нет сессии" });
    const id = safeId(ses.id || uid("room"));
    ses.id = id;
    ses.updatedAt = nowIso();
    ensureWatchCode(ses);
    writeJson(roomFile(id), ses);
    sendJson(res, 200, { session: ses, ...roomLinks(ses) });
    return;
  }

  if (method === "GET" && p === "/api/state") {
    const settings = loadSettings(ws);
    const store = mergeStores(loadStore(ws));
    sendJson(res, 200, { settings: publicSettings(settings), store, info: { publicUrl: publicUrl(), google: true, localWatch: `http://127.0.0.1:${PORT}/watch` } });
    return;
  }

  if (method === "POST" && p === "/api/settings") {
    const body = await readBody(req);
    const pack = loadWorkspace(ws);
    const cur = { ...defaultSettings(), ...(pack.settings || {}) };
    const next = { ...cur };
    for (const k of ["uiLang", "theme", "sourceLang", "targetLang", "fontScale"]) {
      if (body[k] !== undefined) next[k] = body[k];
    }
    if (typeof body.xaiKey === "string") next.xaiKey = body.xaiKey.trim();
    pack.settings = next;
    saveWorkspace(ws, pack);
    sendJson(res, 200, { settings: publicSettings(next) });
    return;
  }

  if (method === "POST" && p === "/api/sessions") {
    const body = await readBody(req);
    const store = loadStore(ws);
    const settings = loadSettings(ws);
    const ses = {
      id: uid("ses"),
      title: body.title || "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      sourceLang: body.sourceLang || settings.sourceLang,
      targetLang: body.targetLang || settings.targetLang,
      notes: body.notes || "",
      glossary: [],
      messages: [],
    };
    store.sessions.unshift(ses);
    store.currentId = ses.id;
    saveStore(ws, store);
    sendJson(res, 200, { store: mergeStores(store), session: ses });
    return;
  }

  const sesPatch = p.match(/^\/api\/sessions\/([^/]+)$/);
  if (sesPatch) {
    const id = decodeURIComponent(sesPatch[1]);
    const store = loadStore(ws);
    let ses = findSession(store, id);
    if (!ses) {
      const room = readJson(roomFile(id), null);
      if (room) {
        ses = room;
        store.sessions.unshift(ses);
      }
    }
    if (!ses) return sendJson(res, 404, { error: "Сессия не найдена" });
    if (method === "POST") {
      const body = await readBody(req);
      if (body.title !== undefined) ses.title = body.title;
      if (body.notes !== undefined) ses.notes = body.notes;
      if (body.sourceLang) ses.sourceLang = body.sourceLang;
      if (body.targetLang) ses.targetLang = body.targetLang;
      if (Array.isArray(body.glossary)) ses.glossary = mergeGlossary(ses.glossary, body.glossary);
      if (Array.isArray(body.messages)) ses.messages = mergeMessages(ses.messages, body.messages, ses.deletedIds);
      if (body.select) store.currentId = ses.id;
      ses.updatedAt = nowIso();
      const room = await withLock("room:" + ses.id, () => saveRoomMerged(ses.id, ses));
      const idx = store.sessions.findIndex((s) => s.id === ses.id);
      if (idx >= 0) store.sessions[idx] = room;
      else store.sessions.unshift(room);
      saveStore(ws, store);
      sendJson(res, 200, { store: mergeStores(store), session: room });
      return;
    }
    if (method === "DELETE") {
      store.sessions = store.sessions.filter((s) => s.id !== id);
      try {
        fs.unlinkSync(roomFile(id));
      } catch {
        /* already gone */
      }
      if (store.sessions.length === 0) {
        const fresh = defaultStore();
        saveStore(ws, fresh);
        sendJson(res, 200, { store: mergeStores(fresh) });
        return;
      }
      if (store.currentId === id) store.currentId = store.sessions[0].id;
      saveStore(ws, store);
      sendJson(res, 200, { store: mergeStores(store) });
      return;
    }
  }

  const glossAdd = p.match(/^\/api\/sessions\/([^/]+)\/glossary$/);
  if (glossAdd && method === "POST") {
    const id = decodeURIComponent(glossAdd[1]);
    const store = loadStore(ws);
    const ses = findOrImportSession(store, id);
    if (!ses) return sendJson(res, 404, { error: "Сессия не найдена" });
    const body = await readBody(req);
    if (!ses.glossary) ses.glossary = [];
    if (body.removeId) {
      ses.glossary = ses.glossary.filter((g) => g.id !== body.removeId);
    } else if (body.src && body.tgt) {
      ses.glossary.push({
        id: uid("g"),
        src: body.src.trim(),
        tgt: body.tgt.trim(),
        note: (body.note || "").trim(),
      });
    }
    ses.updatedAt = nowIso();
    saveStore(ws, store);
    const room = await withLock("room:" + ses.id, () => saveRoomMerged(ses.id, ses));
    sendJson(res, 200, { session: room, store: mergeStores(store) });
    return;
  }

  if (method === "POST" && p === "/api/translate") {
    const body = await readBody(req);
    const settings = loadSettings(ws);
    const store = loadStore(ws);
    const ses = findOrImportSession(store, body.sessionId || store.currentId);
    const result = await translateText({
      text: body.text,
      sourceLang: body.sourceLang,
      targetLang: body.targetLang,
      session: ses,
      settings,
    });
    sendJson(res, 200, result);
    return;
  }

  if (method === "POST" && p === "/api/inspect") {
    const body = await readBody(req);
    const settings = loadSettings(ws);
    const store = loadStore(ws);
    const ses = findOrImportSession(store, body.sessionId || store.currentId);
    let lang = body.lang;
    if (!lang) lang = detectLang(body.word) || settings.sourceLang || "ru";
    const result = await inspectWord({
      word: body.word,
      sentence: body.sentence || "",
      lang,
      session: ses,
      settings,
      targetLang: body.targetLang,
    });
    sendJson(res, 200, result);
    return;
  }

  const msgAdd = p.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (msgAdd && method === "POST") {
    const id = decodeURIComponent(msgAdd[1]);
    const store = loadStore(ws);
    const ses = findOrImportSession(store, id);
    if (!ses) return sendJson(res, 404, { error: "Сессия не найдена" });
    const body = await readBody(req);
    const settings = loadSettings(ws);
    const sourceLang = body.sourceLang || ses.sourceLang || settings.sourceLang;
    const targetLang = body.targetLang || ses.targetLang || settings.targetLang;
    let translated = body.translated;
    let engine = body.engine || "given";
    if (!translated) {
      const tr = await translateText({
        text: body.original,
        sourceLang,
        targetLang,
        session: ses,
        settings,
      });
      translated = tr.translated;
      engine = tr.engine;
    }
    const msg = {
      id: uid("msg"),
      speaker: body.speaker === "them" ? "them" : "me",
      sourceLang,
      targetLang,
      original: String(body.original || "").trim(),
      translated: String(translated || "").trim(),
      engine,
      createdAt: nowIso(),
    };
    ses.messages.push(msg);
    ses.updatedAt = nowIso();
    if (!ses.title) ses.title = sessionTitle(ses);
    store.currentId = ses.id;
    saveStore(ws, store);
    const room = await withLock("room:" + ses.id, () => saveRoomMerged(ses.id, ses));
    ses.messages = room.messages;
    ses.glossary = room.glossary;
    ses.deletedIds = room.deletedIds;
    saveStore(ws, store);
    sendJson(res, 200, { message: msg, session: room, store: mergeStores(store) });
    return;
  }

  const msgDel = p.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)$/);
  if (msgDel && method === "DELETE") {
    const sid = decodeURIComponent(msgDel[1]);
    const mid = decodeURIComponent(msgDel[2]);
    const store = loadStore(ws);
    const ses = findOrImportSession(store, sid);
    if (!ses) return sendJson(res, 404, { error: "Сессия не найдена" });
    ses.deletedIds = [...new Set([...(ses.deletedIds || []), mid])];
    ses.messages = (ses.messages || []).filter((m) => m.id !== mid);
    ses.updatedAt = nowIso();
    saveStore(ws, store);
    const room = await withLock("room:" + ses.id, () => saveRoomMerged(ses.id, ses));
    sendJson(res, 200, { session: room, store: mergeStores(store) });
    return;
  }

  const exp = p.match(/^\/api\/sessions\/([^/]+)\/export$/);
  if (exp && method === "GET") {
    const id = decodeURIComponent(exp[1]);
    const store = loadStore(ws);
    const ses = findOrImportSession(store, id);
    if (!ses) return sendJson(res, 404, { error: "Сессия не найдена" });
    const fmt = url.searchParams.get("fmt") || "txt";
    const content = exportSession(ses, fmt);
    if (fmt === "html") return sendText(res, 200, content, "text/html; charset=utf-8");
    sendText(res, 200, content, "text/plain; charset=utf-8");
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message || "Server error" });
  }
});

function findBrowser() {
  const candidates = [
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function openApp() {
  const url = `http://127.0.0.1:${PORT}`;
  const browser = findBrowser();
  if (browser) {
    execFile(browser, [`--app=${url}`, "--window-size=1480,940", "--new-window"], { windowsHide: true }, (err) => {
      if (err) {
        execFile("cmd", ["/c", "start", "", url], { windowsHide: true });
      }
    });
    return;
  }
  execFile("cmd", ["/c", "start", "", url], { windowsHide: true });
}

function listen() {
  server.listen(PORT, HOST, () => {
    console.log(`Переговори: http://127.0.0.1:${PORT}`);
    for (const ip of lanAddresses()) console.log(`Мережа:     http://${ip}:${PORT}`);
    const pub = publicUrl();
    if (pub) console.log(`Публічно:   ${pub}`);
    if (process.argv.includes("--no-open")) return;
    openApp();
  });
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log("Вже запущено, відкриваю вікно…");
    openApp();
    setTimeout(() => process.exit(0), 1200);
    return;
  }
  console.error(err);
  process.exit(1);
});

listen();
