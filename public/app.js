(() => {
  const WORD_RE = /[\p{L}''’-]+/gu;
  const $ = (id) => document.getElementById(id);

  const state = {
    settings: {
      uiLang: "ru",
      theme: "paper",
      sourceLang: "ru",
      targetLang: "uk",
      fontScale: 1,
      hasXai: false,
    },
    store: { currentId: "", sessions: [] },
    speaker: "me",
    draft: "",
    draftTr: "",
    draftEngine: "",
    inspecting: null,
    inspectData: null,
    busy: "",
    saveTimer: null,
    trTimer: null,
    search: "",
    lastStatus: "",
    sideTab: "sessions",
    sideOpen: false,
    paneView: "",
    people: [],
    health: { status: "ready" },
    offline: false,
  };

  const t = (key) => {
    const pack = I18N[state.settings.uiLang] || I18N.ru;
    return key.split(".").reduce((a, k) => (a ? a[k] : ""), pack) || key;
  };

  const session = () =>
    state.store.sessions.find((s) => s.id === state.store.currentId) ||
    state.store.sessions[0];

  const LANGS = [
    { id: "ru", ru: "Русский", uk: "Російська" },
    { id: "uk", ru: "Украинский", uk: "Українська" },
    { id: "en", ru: "Английский", uk: "Англійська" },
  ];

  function langName(id) {
    const ui = state.settings.uiLang === "uk" ? "uk" : "ru";
    const row = LANGS.find((l) => l.id === id);
    return row ? row[ui] : String(id || "").toUpperCase();
  }

  function sessionPair() {
    const ses = session();
    return {
      src: state.settings.sourceLang || ses?.sourceLang || "ru",
      tgt: state.settings.targetLang || ses?.targetLang || "uk",
    };
  }

  function speakPair() {
    const { src, tgt } = sessionPair();
    if (state.speaker === "them") return { sourceLang: tgt, targetLang: src };
    return { sourceLang: src, targetLang: tgt };
  }

  function detectClientLang(text) {
    const s = String(text || "");
    const uk = (s.match(/[іІїЇєЄґҐ]/g) || []).length;
    const ru = (s.match(/[ыЫэЭъЪёЁ]/g) || []).length;
    if (uk > ru) return "uk";
    if (ru > uk) return "ru";
    return null;
  }

  function pairForText(text) {
    const pair = speakPair();
    const detected = detectClientLang(text);
    if (detected && detected === pair.targetLang && detected !== pair.sourceLang) {
      return { sourceLang: pair.targetLang, targetLang: pair.sourceLang };
    }
    return pair;
  }

  const LANG_ORDER = ["ru", "uk", "en"];
  const NATIVE_LANG = { ru: "Русский", uk: "Українська", en: "English" };

  function columnLangs() {
    const { src, tgt } = sessionPair();
    const pair = [src || "ru", tgt || "uk"];
    return pair.sort((a, b) => {
      const ia = LANG_ORDER.indexOf(a);
      const ib = LANG_ORDER.indexOf(b);
      return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib);
    });
  }

  function nativeLangTitle(id) {
    return NATIVE_LANG[id] || String(id || "").toUpperCase();
  }

  function textForLang(m, lang) {
    if (!m) return "";
    if ((m.sourceLang || "") === lang) return m.original || "";
    if ((m.targetLang || "") === lang) return m.translated || "";
    const [left, right] = columnLangs();
    if (lang === left) return m.original || "";
    if (lang === right) return m.translated || "";
    return "";
  }

  function showToast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
  }

  function isNarrow() {
    return window.matchMedia("(max-width: 1100px)").matches;
  }

  function wsId() {
    let id = localStorage.getItem("peregovory_ws");
    if (!id) {
      id = "ws_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem("peregovory_ws", id);
    }
    return id;
  }

  async function api(path, opts = {}) {
    const u = new URL(path, location.origin);
    u.searchParams.set("ws", wsId());
    const res = await fetch(u.pathname + u.search, {
      headers: { "Content-Type": "application/json" },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  async function googleTranslate(text, sl, tl) {
    if (window.GoogleTX) {
      try {
        const g = await GoogleTX.translate(text, sl, tl);
        if (g && g.translated) return g;
      } catch (e) {
        console.warn("Google direct", e);
      }
    }
    return api("/api/translate", {
      method: "POST",
      body: {
        text,
        sourceLang: sl,
        targetLang: tl,
        sessionId: state.store.currentId,
      },
    });
  }

  async function googleInspect(word, sentence, lang) {
    if (window.GoogleTX) {
      try {
        const g = await GoogleTX.lookup(word, lang, state.settings.targetLang);
        if (g && (g.senses?.length || g.translation)) return g;
      } catch (e) {
        console.warn("Google inspect", e);
      }
    }
    return api("/api/inspect", {
      method: "POST",
      body: {
        word,
        sentence,
        lang,
        targetLang: state.settings.targetLang,
        sessionId: state.store.currentId,
      },
    });
  }

  function liveLink() {
    const id = state.sharedRoom || session()?.id || "main";
    const base = (state.publicUrl || location.origin).replace(/\/$/, "").split("?")[0];
    const code = state.watchCode;
    if (code) return `${base}/watch/${encodeURIComponent(code)}`;
    return `${base}/watch.html?room=${encodeURIComponent(id)}`;
  }

  function applyWatchMeta(data) {
    if (!data) return;
    if (data.watchCode) state.watchCode = String(data.watchCode).toUpperCase();
    if (data.watch) state.watchUrl = data.watch;
    if (Array.isArray(data.lanWatch)) state.lanWatch = data.lanWatch;
    if (data.localWatch) state.localWatch = data.localWatch;
    const codeEl = $("liveCode");
    if (codeEl) {
      if (state.watchCode) {
        codeEl.hidden = false;
        codeEl.textContent = state.watchCode;
        codeEl.title = t("watchCode") + " — " + t("copyCode");
      } else {
        codeEl.hidden = true;
      }
    }
    if ($("liveUrl")) $("liveUrl").value = state.watchUrl || liveLink();
  }

  async function publishRoom() {
    const ses = session();
    if (!ses) return "";
    state.sharedRoom = ses.id;
    const data = await api("/api/rooms/" + ses.id, { method: "POST", body: { session: ses } });
    applyWatchMeta(data);
    return data.watch || liveLink();
  }

  function applyChrome() {
    document.documentElement.lang = state.settings.uiLang;
    document.body.dataset.theme = state.settings.theme || "paper";
    document.body.style.setProperty("--font-scale", String(state.settings.fontScale || 1));
    $("appName").textContent = t("appName");
    $("appSub").textContent = t("appSub");
    $("btnNew").textContent = "+ " + t("newSession");
    $("btnSide").textContent = t("sessions");
    $("btnSide").title = t("sessions");
    const sesCount = (state.store.sessions || []).length;
    $("tabSessions").textContent = sesCount ? `${t("sessions")} (${sesCount})` : t("sessions");
    $("tabContext").textContent = t("context");
    $("tabGlossary").textContent = t("glossary");
    $("search").placeholder = t("searchPh");
    $("lblUiLang").textContent = t("uiLang");
    $("uiLangSel").options[0].text = t("langRu");
    $("uiLangSel").options[1].text = t("langUk");
    $("uiLangSel").value = state.settings.uiLang === "uk" ? "uk" : "ru";
    $("lblFont").textContent = t("fontSize");
    $("btnSettings").title = t("settings");
    $("uiSwitch").title = t("uiLang");
    $("ctxTitle").textContent = t("context");
    $("ctxHint").textContent = t("contextHint");
    $("notes").placeholder = t("contextPh");
    $("glossTitle").textContent = t("glossary");
    $("glossHint").textContent = t("glossaryHint");
    $("glossSrc").placeholder = t("termSrc");
    $("glossTgt").placeholder = t("termTgt");
    const cols = columnLangs();
    $("origHead").textContent = nativeLangTitle(cols[0]);
    $("transHead").textContent = nativeLangTitle(cols[1]);
    $("tabOrig").textContent = nativeLangTitle(cols[0]);
    $("tabTrans").textContent = nativeLangTitle(cols[1]);
    $("tabBoth").textContent = t("colBoth");
    $("spMe").textContent = t("me");
    $("spThem").textContent = t("them");
    $("btnInspect").textContent = t("synonyms");
    $("draft").placeholder = t("placeholder");
    $("shortcut").textContent = t("shortcut");
    $("btnSend").textContent = t("send");
    $("sessionTitle").placeholder = t("rename");
    $("setTitle").textContent = t("settings");
    $("lblTheme").textContent = t("theme");
    $("theme").options[0].text = t("themePaper");
    $("theme").options[1].text = t("themeNight");
    $("lblKey").textContent = t("xaiKey");
    $("keyHint").textContent = t("xaiHint");
    $("btnExportTxt").textContent = t("export") + " · " + t("exportTxt");
    $("btnExportHtml").textContent = t("exportHtml");
    $("btnDelSes").textContent = t("deleteSession");
    $("btnCloseSet").textContent = t("close");
    $("btnSaveSet").textContent = t("saveSettings");
    $("btnSwap").title = t("swap");
    $("btnShare").textContent = t("share");
    $("liveLbl").textContent = t("liveLbl");
    $("btnCopyLive").textContent = t("copyLink");
    $("liveUrl").value = liveLink();
    applyWatchMeta({ watchCode: state.watchCode, watch: liveLink(), lanWatch: state.lanWatch, localWatch: state.localWatch });
    if ($("watchModalTitle")) {
      $("watchModalTitle").textContent = t("inviteTitle");
      $("watchModalHint").textContent = t("inviteHint");
      $("lblWatchCode").textContent = t("watchCode");
      $("lblWatchQr").textContent = t("inviteQr");
      $("lblWatchLink").textContent = t("invitePublic");
      $("lblWatchLan").textContent = t("inviteLan");
      $("watchAnyoneHint").textContent = t("watchAnyone");
      $("btnWatchPreview").textContent = t("watchPreview");
      $("btnCloseWatch").textContent = t("close");
      $("btnCopyWatch").textContent = t("copyLink");
      $("watchCodeBig").title = t("copyCode");
    }
    $("srcLbl").textContent = (cols[0] || "ru").toUpperCase();
    $("tgtLbl").textContent = (cols[1] || "uk").toUpperCase();
    $("speakerSeg").title = t("speakAs");
    document.title = t("appName");
    applySideTab();
    applyPaneView();
    renderHealth();
    renderPeople();
    renderDirHint();
    for (const b of $("uiSwitch").querySelectorAll("button")) {
      b.classList.toggle("on", b.dataset.lang === state.settings.uiLang);
    }
    $("engineLbl").textContent = t("googleOn");
    $("engineDot").classList.remove("off");

    const fill = (el, val) => {
      const ui = state.settings.uiLang === "uk" ? "uk" : "ru";
      el.innerHTML = LANGS.map((l) => `<option value="${l.id}">${l[ui]} (${l.id.toUpperCase()})</option>`).join("");
      el.value = val;
    };
    fill($("srcLang"), state.settings.sourceLang || "ru");
    fill($("tgtLang"), state.settings.targetLang || "uk");
    for (const b of $("speakerSeg").querySelectorAll("button")) {
      b.classList.toggle("on", b.dataset.sp === state.speaker);
    }
    $("theme").value = state.settings.theme || "paper";
    $("fontScale").value = state.settings.fontScale || 1;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function highlight(text, q) {
    const safe = escapeHtml(text);
    if (!q) return safe;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return safe.replace(re, (m) => `<mark class="hl">${m}</mark>`);
  }

  function tokenize(text, q, msgId, field) {
    const parts = [];
    let last = 0;
    const src = String(text || "");
    src.replace(WORD_RE, (w, i) => {
      if (i > last) parts.push(highlight(src.slice(last, i), q));
      const on =
        state.inspecting &&
        state.inspecting.word === w &&
        state.inspecting.msgId === msgId &&
        state.inspecting.field === field
          ? " on"
          : "";
      parts.push(
        `<button type="button" class="w${on}" data-w="${escapeHtml(w)}" data-mid="${escapeHtml(
          msgId || ""
        )}" data-field="${field}">${highlight(w, q)}</button>`
      );
      last = i + w.length;
      return w;
    });
    if (last < src.length) parts.push(highlight(src.slice(last), q));
    return parts.join("") || highlight(src, q);
  }

  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleString(state.settings.uiLang === "uk" ? "uk-UA" : "ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
    });
  }

  function filteredMessages(ses) {
    const q = state.search.trim().toLowerCase();
    const msgs = ses.messages || [];
    if (!q) return msgs;
    return msgs.filter(
      (m) =>
        (m.original || "").toLowerCase().includes(q) ||
        (m.translated || "").toLowerCase().includes(q)
    );
  }

  function sessionLabel(s) {
    if (s.title && s.title.trim()) return s.title.trim();
    const first = (s.messages || []).find((m) => (m.original || "").trim());
    if (first) {
      const line = first.original.trim().replace(/\s+/g, " ");
      return line.length > 42 ? line.slice(0, 42) + "…" : line;
    }
    if (s.id === "main") return t("publicSession");
    return t("untitled");
  }

  function mergeSessionList(list) {
    const map = new Map();
    for (const s of state.store.sessions || []) {
      if (s && s.id) map.set(s.id, s);
    }
    for (const s of list || []) {
      if (!s || !s.id) continue;
      const cur = map.get(s.id);
      if (!cur) {
        map.set(s.id, s);
        continue;
      }
      const del = new Set([...(cur.deletedIds || []), ...(s.deletedIds || [])]);
      const msgs = new Map();
      for (const m of cur.messages || []) {
        if (m && m.id && !del.has(m.id)) msgs.set(m.id, m);
      }
      for (const m of s.messages || []) {
        if (m && m.id && !del.has(m.id)) msgs.set(m.id, m);
      }
      const newer = String(s.updatedAt || "") >= String(cur.updatedAt || "") ? s : cur;
      const older = newer === s ? cur : s;
      map.set(s.id, {
        ...older,
        ...newer,
        notes: newer.notes != null ? newer.notes : older.notes,
        glossary: (s.glossary || []).length >= (cur.glossary || []).length ? s.glossary : cur.glossary,
        messages: [...msgs.values()].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""))),
        deletedIds: [...del],
      });
    }
    state.store.sessions = [...map.values()].sort((a, b) =>
      String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))
    );
    if (!state.store.sessions.some((s) => s.id === state.store.currentId)) {
      state.store.currentId = state.store.sessions[0]?.id || "";
    }
  }

  function applyPaneView() {
    if (state.paneView === "orig") state.paneView = "left";
    if (state.paneView === "trans") state.paneView = "right";
    if (!["both", "left", "right"].includes(state.paneView)) state.paneView = "both";
    document.body.classList.remove("view-orig", "view-trans", "view-both", "view-left", "view-right");
    document.body.classList.add("view-" + state.paneView);
    for (const b of $("paneTabs").querySelectorAll("button")) {
      b.classList.toggle("on", b.dataset.view === state.paneView);
    }
  }

  function renderHealth() {
    const chip = $("healthChip");
    const lbl = $("healthLbl");
    if (!chip || !lbl) return;
    let kind = "ok";
    let text = t("healthOk");
    if (state.offline) {
      kind = "offline";
      text = t("healthOffline");
    } else if ((state.people || []).length >= 2) {
      kind = "great";
      text = t("healthGreat");
    } else {
      kind = "great";
      text = t("healthGreat");
    }
    chip.className = "chip health " + kind;
    chip.title = t("togetherHint");
    lbl.textContent = text;
  }

  function renderPeople() {
    const box = $("people");
    if (!box) return;
    const list = state.people || [];
    if (!list.length) {
      box.innerHTML = `<span class="person">${escapeHtml(t("peopleAlone"))}</span>`;
      return;
    }
    const counts = { me: 0, them: 0, view: 0 };
    for (const p of list) counts[p.speaker === "them" ? "them" : p.speaker === "view" ? "view" : "me"] += 1;
    const parts = [];
    if (counts.me) parts.push(`<span class="person me"><i></i>${escapeHtml(t("me"))}${counts.me > 1 ? " · " + counts.me : ""}</span>`);
    if (counts.them) parts.push(`<span class="person them"><i></i>${escapeHtml(t("them"))}${counts.them > 1 ? " · " + counts.them : ""}</span>`);
    if (counts.view) parts.push(`<span class="person view"><i></i>${escapeHtml(t("viewer"))}${counts.view > 1 ? " · " + counts.view : ""}</span>`);
    if (list.length >= 2) parts.unshift(`<span class="person"><i></i>${escapeHtml(t("notAlone"))}</span>`);
    box.innerHTML = parts.join("");
  }

  function renderDirHint() {
    const el = $("dirHint");
    if (!el) return;
    const pair = speakPair();
    const who = state.speaker === "them" ? t("dirHintThem") : t("dirHintMe");
    el.textContent = `${who}: ${langName(pair.sourceLang)} → ${langName(pair.targetLang)}`;
  }

  async function refreshRooms() {
    try {
      const data = await api("/api/rooms");
      mergeSessionList(data.rooms || []);
    } catch {
      /* offline */
    }
  }

  function applySideTab() {
    const tab = state.sideTab || "sessions";
    for (const b of $("sideTabs").querySelectorAll("button")) {
      b.classList.toggle("on", b.dataset.tab === tab);
    }
    for (const p of document.querySelectorAll(".side-panel")) {
      p.classList.toggle("hidden", p.dataset.panel !== tab);
    }
    document.body.classList.toggle("side-open", Boolean(state.sideOpen));
    $("btnSide").classList.toggle("on", tab === "sessions");
  }

  function openSide(open) {
    state.sideOpen = open;
    state.sideTab = "sessions";
    applySideTab();
  }

  function renderSessions() {
    const q = state.search.trim().toLowerCase();
    const box = $("sessionList");
    const items = (state.store.sessions || []).filter((s) => {
      if (!q) return true;
      const blob = [s.title, s.notes, ...(s.messages || []).flatMap((m) => [m.original, m.translated])]
        .join("\n")
        .toLowerCase();
      return blob.includes(q);
    });
    if (!items.length) {
      box.innerHTML = `<div class="empty-ses">${escapeHtml(t("emptySessions"))}</div>`;
      return;
    }
    box.innerHTML = items
      .map((s) => {
        const title = sessionLabel(s);
        const n = (s.messages || []).length;
        const when = fmtTime(s.updatedAt || s.createdAt);
        return `<button class="ses${s.id === state.store.currentId ? " on" : ""}" data-id="${s.id}">
          <b>${escapeHtml(title)}</b>
          <span>${n} ${t("replies")} · ${escapeHtml(when)}</span>
        </button>`;
      })
      .join("");
  }

  function renderTerms(ses) {
    $("terms").innerHTML = (ses.glossary || [])
      .map(
        (g) => `<li><span>${escapeHtml(g.src)} → ${escapeHtml(g.tgt)}</span>
        <button type="button" data-gid="${g.id}" title="${t("delete")}">✕</button></li>`
      )
      .join("");
  }

  function renderFeeds() {
    const ses = session();
    if (!ses) return;
    const box = $("protocol");
    if (!box) return;
    const keep = box.scrollTop;
    const stick = box.dataset.stick !== "0";
    const q = state.search.trim();
    const msgs = filteredMessages(ses);
    const [left, right] = columnLangs();
    const draftMsg = state.draft.trim()
      ? {
          id: "draft",
          speaker: state.speaker,
          original: state.draft,
          translated: state.draftTr || (state.busy ? t("translating") : "…"),
          createdAt: "",
          engine: state.draftEngine,
          sourceLang: (state.draftPair || speakPair()).sourceLang,
          targetLang: (state.draftPair || speakPair()).targetLang,
          draft: true,
        }
      : null;
    const all = draftMsg ? msgs.concat([draftMsg]) : msgs;
    if (!all.length) {
      box.innerHTML = `<div class="empty"><b>${escapeHtml(t("healthGreat"))}</b>${escapeHtml(t("emptyStart"))}</div>`;
      return;
    }
    box.innerHTML = all
      .map((m) => {
        return `<div class="turn" data-mid="${escapeHtml(m.id)}">
          <div class="cell left" data-lang="${escapeHtml(left)}">${cardHtml(m, left, q)}</div>
          <div class="cell right" data-lang="${escapeHtml(right)}">${cardHtml(m, right, q)}</div>
        </div>`;
      })
      .join("");
    box.scrollTop = stick ? box.scrollHeight : keep;
  }

  function cardHtml(m, lang, q) {
    const text = textForLang(m, lang);
    const who = m.speaker === "them" ? t("them") : t("me");
    const eng = m.engine && t("engine." + m.engine) ? t("engine." + m.engine) : "";
    const cls = `card ${m.speaker}${m.draft ? " draft" : ""}`;
    const actions =
      m.draft
        ? `<span class="ghost">${t("draft")}</span>`
        : `<div class="card-actions">
            <button class="ghost" data-copy="${escapeHtml(lang)}" data-mid="${m.id}">${t("copy")}</button>
            <button class="ghost" data-del="${m.id}">✕</button>
          </div>`;
    return `<div class="lang-tag">${escapeHtml(nativeLangTitle(lang))}</div>
      <article class="${cls}" data-mid="${m.id}" data-lang="${escapeHtml(lang)}">
      <div class="meta"><span>${who}${m.draft ? " · " + t("draft") : ""}</span><span>${fmtTime(m.createdAt)}${eng ? " · " + eng : ""}</span></div>
      ${actions}
      <div class="body">${tokenize(text, q, m.id, lang)}</div>
    </article>`;
  }

  function renderInspector() {
    const box = $("inspector");
    const d = state.inspectData;
    document.body.classList.toggle("inspect-open", Boolean(d));
    if (!d) {
      box.innerHTML = "";
      return;
    }
    const senses = d.senses || [];
    if (!senses.length) {
      box.innerHTML = `<div class="inspector-head"><h3>${t("synonyms")}</h3>
        <button class="ghost" id="btnHideInspect" type="button">${t("inspectHide")}</button></div>
        <div class="word">${escapeHtml(d.word)}</div>
        <div class="tr">${d.translation ? escapeHtml(d.translation) : ""}</div>
        <p class="hint">${t("noSyn")}</p>`;
      return;
    }
    const rec = d.recommended;
    let html = `<div class="inspector-head"><h3>${t("synonyms")}</h3>
      <button class="ghost" id="btnHideInspect" type="button">${t("inspectHide")}</button></div>
      <div class="word">${escapeHtml(d.word)}</div>
      <div class="tr">${d.translation ? escapeHtml(d.translation) : ""}</div>
      ${d.why ? `<div class="why">${escapeHtml(d.why)}</div>` : ""}`;
    for (const s of senses) {
      html += `<div class="sense"><p>${escapeHtml(s.gloss || "")}</p><div class="syns">`;
      for (const syn of s.synonyms || []) {
        const isRec = rec && syn.word === rec;
        html += `<button type="button" class="syn${isRec ? " rec" : ""}" data-syn="${escapeHtml(syn.word)}" data-other="${escapeHtml(
          syn.other || d.translation || ""
        )}">
          <b>${escapeHtml(syn.word)}${isRec ? " · " + t("recommended") : ""}</b>
          <small>${escapeHtml(syn.nuance || "")}</small>
        </button>`;
      }
      html += `</div>`;
      if (s.examples && s.examples.length) {
        html += `<div style="margin-top:8px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">${t("examples")}</div>`;
        for (const e of s.examples) {
          html += `<div class="ex"><div class="ru">${escapeHtml(e.ru || "")}</div><div class="uk">${escapeHtml(e.uk || "")}</div></div>`;
        }
      }
      html += `</div>`;
    }
    if (d.translation) {
      html += `<div class="row" style="margin-top:8px">
        <button class="btn" id="pinInspect" type="button">${t("pinTerm")}</button>
      </div>`;
    }
    box.innerHTML = html;
  }

  function renderAll() {
    applyChrome();
    const ses = session();
    if (ses) {
      if (document.activeElement !== $("sessionTitle")) $("sessionTitle").value = ses.title || "";
      if (document.activeElement !== $("notes")) $("notes").value = ses.notes || "";
      renderTerms(ses);
    }
    renderSessions();
    renderFeeds();
    renderInspector();
    renderHealth();
    renderPeople();
    renderDirHint();
    $("busy").textContent = state.busy;
    if (state.lastStatus) $("saveStatus").textContent = state.lastStatus;
    persistLocal();
  }

  function nearBottom(el) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  }

  function scrollFeeds(force) {
    const el = $("protocol");
    if (!el) return;
    if (force || el.dataset.stick !== "0") el.scrollTop = el.scrollHeight;
  }

  function bindProtocolScroll() {
    const el = $("protocol");
    if (!el) return;
    el.addEventListener("scroll", () => {
      el.dataset.stick = nearBottom(el) ? "1" : "0";
    });
  }

  async function load() {
    const savedUi = localStorage.getItem("peregovory_ui");
    if (savedUi === "ru" || savedUi === "uk") state.settings.uiLang = savedUi;
    try {
      const data = await api("/api/state");
      state.settings = { ...state.settings, ...data.settings };
      if (savedUi === "ru" || savedUi === "uk") state.settings.uiLang = savedUi;
      state.store = data.store;
      mergeSessionList(data.store?.sessions || []);
      if (data.info && data.info.publicUrl) state.publicUrl = data.info.publicUrl;
    } catch {
      const raw = localStorage.getItem("peregovory_data");
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.settings) state.settings = { ...state.settings, ...parsed.settings };
          if (savedUi === "ru" || savedUi === "uk") state.settings.uiLang = savedUi;
          if (parsed.store) state.store = parsed.store;
        } catch {
          /* ignore */
        }
      }
    }
    await refreshRooms();
    const params = new URLSearchParams(location.search);
    let room = params.get("room");
    if (!room) {
      const cur = session();
      const hasWork = cur && ((cur.messages || []).length || (cur.title || "").trim());
      room =
        (hasWork && cur.id) ||
        (state.store.sessions || []).find((s) => s.id === "main")?.id ||
        state.store.currentId ||
        "main";
      history.replaceState({}, "", "?room=" + encodeURIComponent(room));
    }
    await joinRoom(room);
    renderAll();
    startRoomPoll();
    watchPublic();
    await publishRoom();
  }

  async function joinRoom(roomId) {
    try {
      const data = await api("/api/rooms/" + encodeURIComponent(roomId));
      if (!data.session) return;
      mergeSessionList([data.session]);
      state.store.currentId = data.session.id;
      state.sharedRoom = data.session.id;
      if (data.people) state.people = data.people;
      if (data.health) state.health = data.health;
      applyWatchMeta(data);
      state.offline = false;
    } catch {
      state.sharedRoom = roomId;
      state.offline = true;
    }
  }

  async function selectSession(id) {
    try {
      const data = await api("/api/sessions/" + encodeURIComponent(id), {
        method: "POST",
        body: { select: true },
      });
      if (data.store) {
        state.store = data.store;
        mergeSessionList(data.store.sessions || []);
      }
    } catch {
      /* room-only session */
    }
    await joinRoom(id);
    history.replaceState({}, "", "?room=" + encodeURIComponent(id));
    startRoomPoll();
    openSide(false);
    renderAll();
  }

  async function watchPublic() {
    for (let i = 0; i < 40; i++) {
      try {
        const info = await api("/api/info");
        if (info.publicUrl) {
          state.publicUrl = info.publicUrl;
          $("liveUrl").value = liveLink();
          state.lastStatus = t("publicOpen");
          $("saveStatus").textContent = state.lastStatus;
          return;
        }
      } catch {
        /* server still up */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  function persistLocal() {
    try {
      localStorage.setItem("peregovory_data", JSON.stringify({ settings: state.settings, store: state.store }));
    } catch {
      /* quota */
    }
  }

  async function syncShared() {
    const ses = session();
    if (!ses) return;
    state.sharedRoom = ses.id;
    try {
      await api("/api/rooms/" + ses.id, { method: "POST", body: { session: ses } });
    } catch {
      /* offline */
    }
  }

  async function heartbeat() {
    const id = state.sharedRoom || session()?.id;
    if (!id) return;
    try {
      const data = await api("/api/rooms/" + encodeURIComponent(id) + "/presence", {
        method: "POST",
        body: { speaker: state.speaker, uiLang: state.settings.uiLang },
      });
      state.people = data.people || [];
      state.health = data.health || state.health;
      state.offline = false;
      renderPeople();
      renderHealth();
    } catch {
      state.offline = true;
      renderHealth();
    }
  }

  function startRoomPoll() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.beatTimer) clearInterval(state.beatTimer);
    heartbeat();
    state.beatTimer = setInterval(heartbeat, 5000);
    state.pollTimer = setInterval(async () => {
      const id = state.sharedRoom || session()?.id;
      if (!id) return;
      state.pollCount = (state.pollCount || 0) + 1;
      if (state.pollCount % 4 === 0) await refreshRooms();
      try {
        const data = await api("/api/rooms/" + encodeURIComponent(id));
        applyWatchMeta(data);
        const remote = data.session;
        const local = session();
        if (data.people) state.people = data.people;
        if (data.health) state.health = data.health;
        state.offline = false;
        if (!remote) return;
        const del = new Set([...(remote.deletedIds || []), ...(local?.deletedIds || [])]);
        const map = new Map();
        for (const m of remote.messages || []) {
          if (m && m.id && !del.has(m.id)) map.set(m.id, m);
        }
        for (const m of local?.messages || []) {
          if (m && m.id && !del.has(m.id) && !map.has(m.id)) map.set(m.id, m);
        }
        remote.messages = [...map.values()].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
        remote.deletedIds = [...del];
        const remoteIds = remote.messages.map((m) => m.id).join(",");
        const localIds = (local?.messages || []).map((m) => m.id).join(",");
        const peopleKey = (state.people || []).map((p) => p.id).join(",");
        if (
          remoteIds === localIds &&
          (remote.notes || "") === (local?.notes || "") &&
          peopleKey === state.lastPeopleKey
        ) {
          return;
        }
        state.lastPeopleKey = peopleKey;
        mergeSessionList([remote]);
        state.store.currentId = remote.id;
        state.sharedRoom = remote.id;
        renderAll();
      } catch {
        state.offline = true;
        renderHealth();
      }
    }, 1500);
  }

  async function patchSession(body) {
    const ses = session();
    if (!ses) return;
    const data = await api("/api/sessions/" + ses.id, { method: "POST", body });
    state.store = data.store;
    await syncShared();
    renderAll();
  }

  function selectedWord() {
    const ta = $("draft");
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start !== end) return ta.value.slice(start, end).trim();
    const left = ta.value.slice(0, start);
    const right = ta.value.slice(end);
    const m1 = left.match(/[\p{L}''’-]+$/u);
    const m2 = right.match(/^[\p{L}''’-]+/u);
    return ((m1 ? m1[0] : "") + (m2 ? m2[0] : "")).trim();
  }

  function replaceSelected(next) {
    const ta = $("draft");
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start !== end) {
      ta.setRangeText(next, start, end, "end");
    } else {
      const left = ta.value.slice(0, start);
      const right = ta.value.slice(end);
      const m1 = left.match(/[\p{L}''’-]+$/u);
      const m2 = right.match(/^[\p{L}''’-]+/u);
      const a = m1 ? start - m1[0].length : start;
      const b = m2 ? end + m2[0].length : end;
      ta.setRangeText(next, a, b, "end");
    }
    state.draft = ta.value;
    scheduleTranslate();
    ta.focus();
  }

  async function inspect(word, sentence, lang, meta = {}) {
    word = (word || "").trim();
    if (!word) return;
    state.inspecting = { word, ...meta };
    state.busy = t("translating");
    renderInspector();
    try {
      const data = await googleInspect(word, sentence || state.draft, lang || state.settings.sourceLang);
      state.inspectData = data;
    } catch (err) {
      state.inspectData = { word, senses: [], error: err.message };
    }
    state.busy = "";
    renderAll();
  }

  function scheduleTranslate() {
    clearTimeout(state.trTimer);
    const text = state.draft.trim();
    if (!text) {
      state.draftTr = "";
      renderFeeds();
      return;
    }
    state.trTimer = setTimeout(async () => {
      state.busy = t("translating");
      $("busy").textContent = state.busy;
      try {
        const pair = pairForText(text);
        const data = await googleTranslate(text, pair.sourceLang, pair.targetLang);
        if ($("draft").value.trim() === text) {
          state.draftTr = data.translated;
          state.draftEngine = data.engine;
          state.draftPair = pair;
        }
      } catch {
        /* keep previous */
      }
      state.busy = "";
      renderFeeds();
      $("busy").textContent = "";
    }, 550);
  }

  function newId(prefix) {
    return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  async function send() {
    const text = $("draft").value.trim();
    if (!text) return;
    let ses = session();
    if (!ses) return;
    state.busy = t("translating");
    renderAll();
    try {
      const pair = state.draftPair && $("draft").value.trim() === text ? state.draftPair : pairForText(text);
      let translated = state.draftTr && $("draft").value.trim() === text ? state.draftTr : "";
      let engine = state.draftEngine || "google";
      if (!translated) {
        const tr = await googleTranslate(text, pair.sourceLang, pair.targetLang);
        translated = tr.translated;
        engine = tr.engine || "google";
      }
      const msg = {
        id: newId("msg"),
        speaker: state.speaker === "them" ? "them" : "me",
        sourceLang: pair.sourceLang,
        targetLang: pair.targetLang,
        original: text,
        translated: translated || text,
        engine,
        createdAt: new Date().toISOString(),
      };
      ses.messages = ses.messages || [];
      ses.messages.push(msg);
      ses.updatedAt = msg.createdAt;
      if (!ses.title) ses.title = text.slice(0, 42);
      state.sharedRoom = ses.id;
      const data = await api("/api/rooms/" + ses.id + "/messages", {
        method: "POST",
        body: {
          id: msg.id,
          original: msg.original,
          translated: msg.translated,
          engine: msg.engine,
          speaker: msg.speaker,
          sourceLang: msg.sourceLang,
          targetLang: msg.targetLang,
          createdAt: msg.createdAt,
        },
      });
      if (data.session) mergeSessionList([data.session]);
      if (data.people) state.people = data.people;
      state.draft = "";
      state.draftTr = "";
      state.draftPair = null;
      $("draft").value = "";
      state.lastStatus = t("saved");
      state.offline = false;
      const proto = $("protocol");
      if (proto) proto.dataset.stick = "1";
      showToast(t("heard"));
    } catch (err) {
      state.lastStatus = err.message;
    }
    state.busy = "";
    renderAll();
    $("draft").focus();
  }

  async function setUiLang(lang) {
    const next = lang === "uk" ? "uk" : "ru";
    state.settings.uiLang = next;
    localStorage.setItem("peregovory_ui", next);
    try {
      await api("/api/settings", { method: "POST", body: { uiLang: next } });
    } catch {
      /* offline */
    }
    renderAll();
  }

  async function setDirection(dir) {
    const [sourceLang, targetLang] = dir.split("-");
    state.settings.sourceLang = sourceLang;
    state.settings.targetLang = targetLang;
    await api("/api/settings", { method: "POST", body: { sourceLang, targetLang } });
    const ses = session();
    if (ses) await patchSession({ sourceLang, targetLang });
    scheduleTranslate();
    renderAll();
  }

  $("uiSwitch").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) setUiLang(b.dataset.lang);
  });
  $("btnNew").addEventListener("click", async () => {
    const data = await api("/api/sessions", {
      method: "POST",
      body: { sourceLang: state.settings.sourceLang, targetLang: state.settings.targetLang },
    });
    state.store = data.store;
    state.draft = "";
    state.draftTr = "";
    state.sideTab = "sessions";
    $("draft").value = "";
    history.replaceState({}, "", "?room=" + encodeURIComponent(session().id));
    await publishRoom();
    startRoomPoll();
    renderAll();
  });
  $("sessionList").addEventListener("click", async (e) => {
    const b = e.target.closest("button.ses");
    if (!b) return;
    await selectSession(b.dataset.id);
  });
  $("sideTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    state.sideTab = b.dataset.tab;
    applySideTab();
  });
  $("btnSide").addEventListener("click", () => {
    state.sideTab = "sessions";
    if (isNarrow()) state.sideOpen = !state.sideOpen;
    else state.sideOpen = false;
    applySideTab();
    refreshRooms().then(renderSessions);
  });
  $("paneTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (!b) return;
    state.paneView = b.dataset.view;
    applyPaneView();
  });
  $("sideBackdrop").addEventListener("click", () => openSide(false));
  $("search").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderSessions();
    renderFeeds();
  });
  $("sessionTitle").addEventListener("change", (e) => patchSession({ title: e.target.value }));
  $("notes").addEventListener("input", () => {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async () => {
      await patchSession({ notes: $("notes").value });
      state.lastStatus = t("notesSaved");
      $("saveStatus").textContent = state.lastStatus;
    }, 500);
  });
  $("btnGloss").addEventListener("click", async () => {
    const src = $("glossSrc").value.trim();
    const tgt = $("glossTgt").value.trim();
    if (!src || !tgt) return;
    const ses = session();
    const data = await api("/api/sessions/" + ses.id + "/glossary", {
      method: "POST",
      body: { src, tgt },
    });
    state.store = data.store;
    $("glossSrc").value = "";
    $("glossTgt").value = "";
    renderAll();
  });
  $("terms").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-gid]");
    if (!b) return;
    const ses = session();
    const data = await api("/api/sessions/" + ses.id + "/glossary", {
      method: "POST",
      body: { removeId: b.dataset.gid },
    });
    state.store = data.store;
    renderAll();
  });
  $("speakerSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.speaker = b.dataset.sp;
    heartbeat();
    scheduleTranslate();
    renderAll();
  });
  $("srcLang").addEventListener("change", (e) => setDirection(e.target.value + "-" + $("tgtLang").value));
  $("tgtLang").addEventListener("change", (e) => setDirection($("srcLang").value + "-" + e.target.value));
  function fillInvite(url) {
    const watch = url || liveLink();
    $("watchLinkInput").value = watch;
    $("watchCodeBig").textContent = state.watchCode || "••••";
    const lan = (state.lanWatch && state.lanWatch[0]) || "";
    if (lan && lan !== watch) {
      $("watchLanField").style.display = "";
      $("watchLanInput").value = lan;
    } else {
      $("watchLanField").style.display = "none";
    }
    const qr = $("watchQr");
    const ok = window.QR && typeof QR.draw === "function" && QR.draw(qr, watch, 200);
    if (!ok && qr) {
      qr.innerHTML = `<img alt="QR" width="200" height="200" src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=2&data=${encodeURIComponent(watch)}">`;
    }
  }

  async function copyText(text, okMsg) {
    await navigator.clipboard.writeText(text);
    const msg = okMsg || t("copied");
    showToast(msg);
    state.lastStatus = msg;
    $("saveStatus").textContent = msg;
  }

  async function copyLive() {
    try {
      const url = await publishRoom();
      history.replaceState({}, "", "?room=" + encodeURIComponent(session().id));
      $("liveUrl").value = url;
      $("liveUrl").select();
      await copyText(url, t("watchCopied"));
      startRoomPoll();
      renderAll();
    } catch (err) {
      state.lastStatus = err.message;
      $("saveStatus").textContent = state.lastStatus;
    }
  }

  async function openInvite() {
    try {
      const url = await publishRoom();
      history.replaceState({}, "", "?room=" + encodeURIComponent(session().id));
      fillInvite(url);
      $("watchModal").classList.remove("hidden");
      try {
        await navigator.clipboard.writeText(url);
        showToast(t("watchCopied"));
      } catch {
        /* modal is enough */
      }
      startRoomPoll();
      renderAll();
    } catch (err) {
      state.lastStatus = err.message;
      $("saveStatus").textContent = state.lastStatus;
    }
  }

  $("btnShare").addEventListener("click", openInvite);
  $("btnCopyLive").addEventListener("click", copyLive);
  $("liveUrl").addEventListener("focus", (e) => e.target.select());
  $("liveCode").addEventListener("click", async () => {
    if (!state.watchCode) return;
    try {
      await copyText(state.watchCode, t("copied"));
    } catch {
      /* ignore */
    }
  });
  $("watchCodeBig").addEventListener("click", async () => {
    if (!state.watchCode) return;
    try {
      await copyText(state.watchCode, t("copied"));
    } catch {
      /* ignore */
    }
  });
  $("btnCopyWatch").addEventListener("click", async () => {
    const url = $("watchLinkInput").value || liveLink();
    try {
      await copyText(url, t("watchCopied"));
    } catch {
      $("watchLinkInput").select();
    }
  });
  $("btnWatchPreview").addEventListener("click", () => {
    window.open(liveLink(), "_blank", "noopener");
  });
  $("btnCloseWatch").addEventListener("click", () => $("watchModal").classList.add("hidden"));
  $("watchModal").addEventListener("click", (e) => {
    if (e.target.id === "watchModal") $("watchModal").classList.add("hidden");
  });
  $("watchLinkInput").addEventListener("focus", (e) => e.target.select());
  $("watchLanInput").addEventListener("focus", (e) => e.target.select());
  $("btnSwap").addEventListener("click", () => {
    const next = `${state.settings.targetLang}-${state.settings.sourceLang}`;
    setDirection(next);
  });
  $("draft").addEventListener("input", (e) => {
    state.draft = e.target.value;
    scheduleTranslate();
    renderFeeds();
  });
  $("draft").addEventListener("mouseup", () => {
    const w = selectedWord();
    if (w && w.length > 1) inspect(w, $("draft").value, pairForText($("draft").value).sourceLang, { from: "composer" });
  });
  $("draft").addEventListener("keyup", (e) => {
    if (e.key === "Control" || e.key.startsWith("Arrow")) {
      const w = selectedWord();
      if (w && w.length > 1) inspect(w, $("draft").value, pairForText($("draft").value).sourceLang, { from: "composer" });
    }
  });
  $("btnInspect").addEventListener("click", () => {
    const w = selectedWord() || state.draft.trim().split(/\s+/).pop();
    inspect(w, $("draft").value, pairForText($("draft").value).sourceLang, { from: "composer" });
  });
  $("btnSend").addEventListener("click", send);
  $("draft").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  $("inspector").addEventListener("click", async (e) => {
    if (e.target.id === "btnHideInspect") {
      state.inspectData = null;
      state.inspecting = null;
      renderAll();
      return;
    }
    const syn = e.target.closest("[data-syn]");
    if (syn) {
      replaceSelected(syn.dataset.syn);
      return;
    }
    if (e.target.id === "pinInspect" && state.inspectData) {
      const ses = session();
      const data = await api("/api/sessions/" + ses.id + "/glossary", {
        method: "POST",
        body: { src: state.inspectData.word, tgt: state.inspectData.translation || state.inspectData.recommended },
      });
      state.store = data.store;
      renderAll();
    }
  });
  function onFeedClick(e) {
    const w = e.target.closest("button.w");
    if (w) {
      const mid = w.dataset.mid;
      const lang = w.dataset.field;
      const ses = session();
      const msg = (ses.messages || []).find((m) => m.id === mid);
      const sentence = msg ? textForLang(msg, lang) : state.draft;
      inspect(w.dataset.w, sentence, lang, { msgId: mid, field: lang });
      return;
    }
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      const ses = session();
      const msg = (ses.messages || []).find((m) => m.id === copy.dataset.mid);
      if (!msg) return;
      const text = textForLang(msg, copy.dataset.copy);
      navigator.clipboard.writeText(text);
      state.lastStatus = t("copied");
      $("saveStatus").textContent = state.lastStatus;
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      const ses = session();
      api("/api/sessions/" + ses.id + "/messages/" + del.dataset.del, { method: "DELETE" }).then((data) => {
        state.store = data.store;
        renderAll();
      });
    }
  }
  $("protocol").addEventListener("click", onFeedClick);

  $("btnSettings").addEventListener("click", () => $("modal").classList.remove("hidden"));
  $("btnCloseSet").addEventListener("click", () => $("modal").classList.add("hidden"));
  $("modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") $("modal").classList.add("hidden");
  });
  $("btnSaveSet").addEventListener("click", async () => {
    const body = {
      theme: $("theme").value,
      fontScale: Number($("fontScale").value),
      uiLang: $("uiLangSel").value === "uk" ? "uk" : "ru",
    };
    const key = $("xaiKey").value.trim();
    if (key) body.xaiKey = key;
    const data = await api("/api/settings", { method: "POST", body });
    state.settings = { ...state.settings, ...data.settings };
    if (body.uiLang) {
      state.settings.uiLang = body.uiLang;
      localStorage.setItem("peregovory_ui", body.uiLang);
    }
    $("xaiKey").value = "";
    $("modal").classList.add("hidden");
    renderAll();
  });
  $("fontScale").addEventListener("input", (e) => {
    document.body.style.setProperty("--font-scale", e.target.value);
  });
  $("btnExportTxt").addEventListener("click", () => {
    window.open("/api/sessions/" + session().id + "/export?fmt=txt", "_blank");
  });
  $("btnExportHtml").addEventListener("click", () => {
    window.open("/api/sessions/" + session().id + "/export?fmt=html", "_blank");
  });
  $("btnDelSes").addEventListener("click", async () => {
    if (!confirm(t("confirmDel"))) return;
    const data = await api("/api/sessions/" + session().id, { method: "DELETE" });
    state.store = data.store;
    $("modal").classList.add("hidden");
    const next = session();
    if (next) {
      history.replaceState({}, "", "?room=" + encodeURIComponent(next.id));
      state.sharedRoom = next.id;
      startRoomPoll();
    }
    renderAll();
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      $("btnNew").click();
    }
    if (e.key === "Escape") {
      $("modal").classList.add("hidden");
      $("watchModal").classList.add("hidden");
      openSide(false);
    }
  });

  bindProtocolScroll();
  load().catch((err) => {
    $("saveStatus").textContent = err.message;
  });
})();
