const STORAGE_KEY = "leo-korean-booklist-v1";
const SYNC_KEY = "leo-korean-booklist-sync-v1";
const SYNC_API = "https://leo-korean-booklist.joyzh1029.workers.dev";

const GRADE_OPTS = [
  { value: "all", label: "全部年级" },
  { value: "1", label: "适合1年级" },
  { value: "2", label: "适合2年级" },
  { value: "1only", label: "仅1年级教科书" },
  { value: "2only", label: "仅2年级教科书" },
];
const SOURCE_OPTS = [
  { value: "all", label: "全部来源" },
  { value: "textbook", label: "教科书收录" },
  { value: "agency", label: "机构推荐" },
  { value: "award", label: "获奖" },
];
const GENRE_OPTS = [
  { value: "all", label: "全部体裁" },
  { value: "picture", label: "图画书" },
  { value: "story", label: "童话" },
  { value: "info", label: "知识书" },
];
const READ_OPTS = [
  { value: "all", label: "全部" },
  { value: "unread", label: "只看未读" },
  { value: "read", label: "只看已读" },
];

const state = {
  view: "shelf",
  grade: "all",
  source: "all",
  genre: "all",
  readFilter: "all",
  query: "",
  page: 0,
  cols: 5,
  selectedId: null,
  libTab: "done",
  libQuery: "",
  monthFilter: "all",
};

let BOOKS = [];
let marks = {};
let lastScrolledId = null;
let syncToken = "";
let syncStatus = ""; // "", "ok", "busy", "error"
let syncMessage = "";
let syncTimer = null;

function todaySeoul() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const seoul = new Date(utc + 9 * 3600000);
  const y = seoul.getFullYear();
  const m = String(seoul.getMonth() + 1).padStart(2, "0");
  const d = String(seoul.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function lastTwelveMonths() {
  const today = todaySeoul();
  const y = Number(today.slice(0, 4));
  const mo = Number(today.slice(5, 7));
  const out = [];
  for (let i = 11; i >= 0; i--) {
    let mm = mo - i;
    let yy = y;
    while (mm <= 0) {
      mm += 12;
      yy -= 1;
    }
    const key = `${yy}-${String(mm).padStart(2, "0")}`;
    out.push({ key, label: `${String(yy).slice(2)}.${mm}` });
  }
  return out;
}

function emptyMark() {
  return { read: false, rating: 0 };
}

function loadMarks() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const today = todaySeoul();
    const next = {};
    for (const id of Object.keys(parsed)) {
      const row = parsed[id] || {};
      const read = !!row.read;
      next[id] = {
        read,
        rating: typeof row.rating === "number" ? row.rating : 0,
        completedAt: row.completedAt || (read ? today : undefined),
        quizScore: row.quizScore,
        quizTotal: row.quizTotal,
        quizPassed: row.quizPassed,
        quizPoints: row.quizPoints,
        quizAttempts: row.quizAttempts,
        quizLastAt: row.quizLastAt,
      };
    }
    marks = next;
  } catch (e) {
    marks = {};
  }
}

function saveMarks() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
  } catch (e) {
    // ignore write errors
  }
}

function patch(id, next) {
  const current = marks[id] || emptyMark();
  const merged = { ...current, ...next };
  if (merged.read && !merged.completedAt) merged.completedAt = todaySeoul();
  merged.updatedAt = Date.now();
  marks = { ...marks, [id]: merged };
  saveMarks();
  render();
  schedulePush();
}

function loadSyncToken() {
  try {
    const raw = window.localStorage.getItem(SYNC_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === "string") syncToken = parsed.token;
  } catch (e) {
    syncToken = "";
  }
}

function saveSyncToken() {
  try {
    if (syncToken) window.localStorage.setItem(SYNC_KEY, JSON.stringify({ token: syncToken }));
    else window.localStorage.removeItem(SYNC_KEY);
  } catch (e) {
    // ignore
  }
}

function pickMark(a, b) {
  const left = a && typeof a === "object" ? a : {};
  const right = b && typeof b === "object" ? b : {};
  const at = typeof left.updatedAt === "number" ? left.updatedAt : 0;
  const bt = typeof right.updatedAt === "number" ? right.updatedAt : 0;
  if (bt !== at) return bt > at ? { ...right } : { ...left };
  const completedAt =
    left.completedAt && right.completedAt
      ? left.completedAt <= right.completedAt
        ? left.completedAt
        : right.completedAt
      : left.completedAt || right.completedAt;
  return {
    ...left,
    ...right,
    read: !!(left.read || right.read),
    rating: Math.max(Number(left.rating) || 0, Number(right.rating) || 0),
    completedAt,
    updatedAt: Math.max(at, bt) || undefined,
    quizScore: right.quizScore ?? left.quizScore,
    quizTotal: right.quizTotal ?? left.quizTotal,
    quizPassed: right.quizPassed ?? left.quizPassed,
    quizPoints: right.quizPoints ?? left.quizPoints,
    quizAttempts: right.quizAttempts ?? left.quizAttempts,
    quizLastAt: right.quizLastAt ?? left.quizLastAt,
  };
}

function mergeMarks(a, b) {
  const out = { ...(a || {}) };
  const incoming = b || {};
  for (const id of Object.keys(incoming)) {
    out[id] = out[id] ? pickMark(out[id], incoming[id]) : incoming[id];
  }
  return out;
}

async function syncRequest(method, path, body) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (syncToken) headers.Authorization = "Bearer " + syncToken;
  const res = await fetch(SYNC_API + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  return { res, data };
}

function schedulePush() {
  if (!syncToken) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    pushMarks().catch(() => {});
  }, 400);
}

async function pushMarks() {
  if (!syncToken) return;
  syncStatus = "busy";
  syncMessage = "正在同步…";
  renderSyncBar();
  try {
    const { res, data } = await syncRequest("PUT", "/marks", { marks });
    if (res.status === 401) {
      syncToken = "";
      saveSyncToken();
      syncStatus = "error";
      syncMessage = "同步登录已失效，请重新输入家庭密码。";
      renderSyncBar();
      return;
    }
    if (!res.ok || !data.ok) throw new Error((data && data.error) || "同步失败");
    marks = mergeMarks(marks, data.marks || {});
    saveMarks();
    syncStatus = "ok";
    syncMessage = "已同步，平板和手机打开同一网址并输入家庭密码即可看到同一份记录。";
    render();
  } catch (e) {
    syncStatus = "error";
    syncMessage = "同步失败，记录已先保存在本机，稍后会再试。";
    renderSyncBar();
  }
}

async function pullAndMerge() {
  if (!syncToken) return;
  syncStatus = "busy";
  syncMessage = "正在同步…";
  renderSyncBar();
  try {
    const { res, data } = await syncRequest("GET", "/marks");
    if (res.status === 401) {
      syncToken = "";
      saveSyncToken();
      syncStatus = "error";
      syncMessage = "同步登录已失效，请重新输入家庭密码。";
      renderSyncBar();
      return;
    }
    if (!res.ok || !data.ok) throw new Error((data && data.error) || "同步失败");
    marks = mergeMarks(data.marks || {}, marks);
    saveMarks();
    const { res: putRes, data: putData } = await syncRequest("PUT", "/marks", { marks });
    if (putRes.ok && putData.ok) marks = mergeMarks(marks, putData.marks || {});
    saveMarks();
    syncStatus = "ok";
    syncMessage = "已同步，平板和手机打开同一网址并输入家庭密码即可看到同一份记录。";
    if (BOOKS.length) render();
    else renderSyncBar();
  } catch (e) {
    syncStatus = "error";
    syncMessage = "同步失败，记录已先保存在本机，稍后会再试。";
    renderSyncBar();
  }
}

async function connectSync(passcode) {
  syncStatus = "busy";
  syncMessage = "正在连接…";
  renderSyncBar();
  try {
    const { res, data } = await syncRequest("POST", "/login", { passcode });
    if (!res.ok || !data.ok || !data.token) {
      syncStatus = "error";
      syncMessage = (data && data.error) || "密码不正确";
      renderSyncBar();
      return;
    }
    syncToken = data.token;
    saveSyncToken();
    await pullAndMerge();
  } catch (e) {
    syncStatus = "error";
    syncMessage = "连接失败，请检查网络后再试。";
    renderSyncBar();
  }
}

async function disconnectSync() {
  try {
    if (syncToken) await syncRequest("POST", "/logout");
  } catch (e) {
    // ignore
  }
  syncToken = "";
  saveSyncToken();
  syncStatus = "";
  syncMessage = "";
  renderSyncBar();
}

function renderSyncBar() {
  const el = document.getElementById("sync-bar");
  if (!el) return;
  el.classList.toggle("is-on", syncStatus === "ok" && !!syncToken);
  el.classList.toggle("is-err", syncStatus === "error");
  if (syncToken) {
    el.innerHTML = `<p class="sync-status">${esc(syncMessage || "已开启同步。")}</p>
      <div class="sync-form">
        <button type="button" class="text-btn" data-sync="refresh">立即同步</button>
        <button type="button" class="text-btn" data-sync="off">断开同步</button>
      </div>`;
    return;
  }
  el.innerHTML = `<p>输入家庭密码后，已读、星级和认证日会在平板和手机之间自动同步。不输入也可以先在这台设备上使用。</p>
    ${syncMessage ? `<p class="sync-status">${esc(syncMessage)}</p>` : ""}
    <form class="sync-form" id="sync-form">
      <input type="password" id="sync-pass" name="passcode" autocomplete="current-password" placeholder="家庭密码" required>
      <button type="submit">连接同步</button>
    </form>`;
}

function bindSyncBar() {
  const el = document.getElementById("sync-bar");
  if (!el || el.dataset.bound) return;
  el.dataset.bound = "1";
  el.addEventListener("submit", (e) => {
    const form = e.target.closest("#sync-form");
    if (!form) return;
    e.preventDefault();
    const inp = document.getElementById("sync-pass");
    const value = inp ? inp.value : "";
    if (inp) inp.value = "";
    if (!value) return;
    connectSync(value);
  });
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sync]");
    if (!btn) return;
    const act = btn.getAttribute("data-sync");
    if (act === "refresh") pullAndMerge();
    if (act === "off") disconnectSync();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && syncToken) pullAndMerge();
  });
  window.addEventListener("online", () => {
    if (syncToken) pullAndMerge();
  });
}

function ydpUrl(title) {
  return (
    "https://www.ydplib.or.kr/intro/menu/10003/program/30001/plusSearchResultList.do?searchType=SIMPLE&searchCategory=ALL&searchKey=TITLE&searchKeyword=" +
    encodeURIComponent(title) +
    "&searchLibrary=ALL"
  );
}

function seoulUrl(title) {
  return "https://lib.seoul.go.kr/search/tot/result?q=" + encodeURIComponent(title) + "&st=KWRD&sts=Y";
}

function gradeLabel(grade, semester) {
  if (semester === "1-1") return "1年级·上学期";
  if (semester === "1-2") return "1年级·下学期";
  if (semester === "2-1") return "2年级·上学期";
  if (semester === "2-2") return "2年级·下学期";
  if (grade === "1") return "1年级";
  if (grade === "2") return "2年级";
  return "1·2年级";
}

function sourceLabel(source) {
  return source === "textbook" ? "教科书收录" : "机构推荐";
}

function genreLabel(genre) {
  if (genre === "picture") return "图画书";
  if (genre === "story") return "童话";
  return "知识书";
}

function coverSrc(book) {
  return book.cover || "covers/" + book.id + ".jpg";
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getFiltered() {
  const q = state.query.trim().toLowerCase();
  return BOOKS.filter((book) => {
    if (state.grade === "1" && book.grade !== "1" && book.grade !== "1-2") return false;
    if (state.grade === "2" && book.grade !== "2" && book.grade !== "1-2") return false;
    if (state.grade === "1only" && book.grade !== "1") return false;
    if (state.grade === "2only" && book.grade !== "2") return false;
    if (state.source !== "all" && book.source !== state.source) return false;
    if (state.genre !== "all" && book.genre !== state.genre) return false;
    const mark = marks[book.id] || emptyMark();
    if (state.readFilter === "unread" && mark.read) return false;
    if (state.readFilter === "read" && !mark.read) return false;
    if (q) {
      const hay = `${book.title} ${book.author} ${book.publisher}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function getLibList() {
  const base =
    state.libTab === "done"
      ? BOOKS.filter((b) => marks[b.id] && marks[b.id].read)
      : BOOKS.filter((b) => !(marks[b.id] && marks[b.id].read));
  const q = state.libQuery.trim().toLowerCase();
  return base.filter((book) => {
    if (state.libTab === "done" && state.monthFilter !== "all") {
      const at = (marks[book.id] && marks[book.id].completedAt) || "";
      if (!at.startsWith(state.monthFilter)) return false;
    }
    if (q && !`${book.title} ${book.author}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function fillSelect(el, options, value) {
  el.innerHTML = options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
  el.value = value;
}

function renderMetrics(filtered, libList, doneCount, textbookCount, agencyCount) {
  const third = state.view === "shelf" ? filtered.length : libList.length;
  const thirdLab = state.view === "shelf" ? "当前书架结果" : "当前记录";
  document.getElementById("metrics").innerHTML = `
    <div class="metric"><div class="val">${BOOKS.length}</div><div class="lab">全部书目</div><div class="sub">教科书 ${textbookCount} · 机构 ${agencyCount}</div></div>
    <div class="metric"><div class="val">${doneCount}/${BOOKS.length}</div><div class="lab">已完成</div><div class="sub">保存在本机浏览器</div></div>
    <div class="metric"><div class="val">${third}</div><div class="lab">${thirdLab}</div></div>
  `;
}

function renderShelf(filtered) {
  const heading = document.getElementById("shelf-heading");
  heading.textContent = `推荐图书（${filtered.length}）`;

  const gradeSeg = document.getElementById("grade-seg");
  gradeSeg.innerHTML = GRADE_OPTS.map(
    (o) => `<button type="button" class="seg-btn${state.grade === o.value ? " is-on" : ""}" data-grade="${o.value}">${esc(o.label)}</button>`
  ).join("");

  const empty = document.getElementById("shelf-empty");
  const shelf = document.getElementById("bookshelf");
  if (filtered.length === 0) {
    empty.hidden = false;
    shelf.hidden = true;
    const awardHint =
      state.source === "award"
        ? "当前筛选没有结果。若选择了“获奖”，本轮未收录独立核实的获奖专表，请换回“全部来源”。"
        : "当前筛选没有结果，请换一组筛选条件。";
    empty.innerHTML = `<div class="callout warn"><strong>没有符合条件的书</strong><p>${awardHint}</p></div>`;
    return;
  }
  empty.hidden = true;
  shelf.hidden = false;

  const perPage = state.cols * 2;
  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(state.page, pageCount - 1);
  if (safePage !== state.page) state.page = safePage;
  const pageItems = filtered.slice(safePage * perPage, safePage * perPage + perPage);
  const rowsEl = document.getElementById("shelf-rows");
  let html = "";
  for (let i = 0; i < pageItems.length; i += state.cols) {
    const row = pageItems.slice(i, i + state.cols);
    html += `<div class="shelf-row" style="grid-template-columns:repeat(${state.cols},1fr)">`;
    for (const book of row) {
      const mark = marks[book.id] || emptyMark();
      html += `<button type="button" class="book" data-open="${esc(book.id)}" aria-label="${esc(book.title)}">
        <span class="book-badges">
          <img src="${esc(coverSrc(book))}" alt="${esc(book.title)} 封面" width="300" loading="lazy">
          ${mark.read ? '<span class="badge">已读</span>' : ""}
          ${mark.rating > 0 ? `<span class="stars-mini">${"★".repeat(mark.rating)}</span>` : ""}
        </span>
      </button>`;
    }
    html += `</div><div class="shelf-plank"></div>`;
  }
  rowsEl.innerHTML = html;

  const btns = [];
  btns.push({ label: "首页", page: 0, disabled: safePage === 0, current: false });
  btns.push({ label: "上一页", page: Math.max(0, safePage - 1), disabled: safePage === 0, current: false });
  for (let i = 0; i < pageCount; i++) btns.push({ label: String(i + 1), page: i, disabled: false, current: i === safePage });
  btns.push({ label: "下一页", page: Math.min(pageCount - 1, safePage + 1), disabled: safePage >= pageCount - 1, current: false });
  btns.push({ label: "末页", page: pageCount - 1, disabled: safePage >= pageCount - 1, current: false });
  document.getElementById("pager").innerHTML = `
    <span class="pager-count">共 ${filtered.length} 本</span>
    <div class="pager-btns">${btns
      .map(
        (b) =>
          `<button type="button" class="pager-btn${b.current ? " current" : ""}" data-page="${b.page}" ${b.disabled ? "disabled" : ""}>${esc(
            b.label
          )}</button>`
      )
      .join("")}</div>`;
}

function renderLibrary(libList, doneCount, learningCount, months, monthCounts) {
  document.getElementById("lib-tabs").innerHTML = `
    <button type="button" class="seg-btn${state.libTab === "done" ? " is-on" : ""}" data-libtab="done">已完成 ${doneCount}</button>
    <button type="button" class="seg-btn${state.libTab === "learning" ? " is-on" : ""}" data-libtab="learning">学习中 ${learningCount}</button>
  `;
  document.getElementById("lib-summary").textContent = `已完成 [总 ${doneCount} 本] · 学习中 [${learningCount} 本]。下图是最近12个月每月完成的书（按认证日统计，当月用蓝色标出）。`;

  const maxVal = Math.max(1, ...monthCounts);
  document.getElementById("chart").innerHTML = months
    .map((m, i) => {
      const h = Math.max(2, Math.round((monthCounts[i] / maxVal) * 100));
      const now = i === months.length - 1;
      return `<div class="bar${now ? " is-now" : ""}"><span class="n">${monthCounts[i]}</span><span class="col" style="height:${h}%"></span><span class="lab">${esc(m.label)}</span></div>`;
    })
    .join("");

  const monthSel = document.getElementById("month-sel");
  const monthOpts = [{ value: "all", label: "全部月份" }, ...months.map((m) => ({ value: m.key, label: m.label }))];
  if (monthSel.options.length !== monthOpts.length) fillSelect(monthSel, monthOpts, state.monthFilter);
  else if (monthSel.value !== state.monthFilter) monthSel.value = state.monthFilter;

  const body = document.getElementById("lib-body");
  if (libList.length === 0) {
    const lead = state.libTab === "done" ? "还没有已完成的书" : "没有符合条件的书";
    const text =
      state.libTab === "done"
        ? "在书架上点开封面，勾选“已读”后会出现在这里，并记下当天的认证日。"
        : "请换一个月份或清空搜索词。";
    body.innerHTML = `<div class="callout info"><strong>${lead}</strong><p>${text}</p></div>`;
    return;
  }

  const rows = libList
    .map((book) => {
      const mark = marks[book.id] || emptyMark();
      const rating = mark.rating > 0 ? `★${mark.rating}` : "尚未评分";
      const date = mark.completedAt || "—";
      const meta = `${gradeLabel(book.grade, book.semester)} · ${sourceLabel(book.source)}`;
      return { book, mark, rating, date, meta };
    })
    .map(({ book, rating, date, meta }) => {
      const tr = `<tr>
        <td><button type="button" class="cover-btn" data-open="${esc(book.id)}" aria-label="查看 ${esc(book.title)}"><img src="${esc(coverSrc(book))}" alt="" width="48" height="68"></button></td>
        <td class="title-cell">${esc(book.title)}</td>
        <td>${esc(meta)}</td>
        <td>${esc(rating)}</td>
        <td>${esc(date)}</td>
        <td><button type="button" class="detail-btn" data-open="${esc(book.id)}">详情</button></td>
      </tr>`;
      const card = `<div class="lib-card">
        <button type="button" class="cover-btn" data-open="${esc(book.id)}"><img src="${esc(coverSrc(book))}" alt="${esc(book.title)} 封面" width="64" height="90"></button>
        <div>
          <div class="title-cell">${esc(book.title)}</div>
          <div class="muted">${esc(meta)}</div>
          <div>${esc(rating)} · ${esc(date)}</div>
          <button type="button" class="detail-btn" data-open="${esc(book.id)}" style="margin-top:8px">详情</button>
        </div>
      </div>`;
      return { tr, card };
    });

  body.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>封面</th><th>书名</th><th>年级 / 来源</th><th>评价</th><th>认证日</th><th></th></tr></thead>
    <tbody>${rows.map((r) => r.tr).join("")}</tbody>
  </table></div>
  <div class="cards">${rows.map((r) => r.card).join("")}</div>`;
}

function renderDetail() {
  const el = document.getElementById("detail");
  const selected = BOOKS.find((b) => b.id === state.selectedId) || null;
  if (!selected) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const mark = marks[selected.id] || emptyMark();
  el.hidden = false;
  const stars = [1, 2, 3, 4, 5]
    .map((n) => `<button type="button" class="star${n <= mark.rating ? " on" : ""}" data-star="${n}" aria-label="评 ${n} 星">★</button>`)
    .join("");
  el.innerHTML = `
    <h2>图书详情：${esc(selected.title)}</h2>
    <div class="detail-body">
      <img class="detail-cover" src="${esc(coverSrc(selected))}" alt="${esc(selected.title)} 封面" width="300">
      <div style="flex:1;min-width:220px">
        <div class="chips">
          <span class="chip src">${esc(sourceLabel(selected.source))}</span>
          <span class="chip">${esc(gradeLabel(selected.grade, selected.semester))}</span>
          <span class="chip">${esc(genreLabel(selected.genre))}</span>
        </div>
        <p>${esc(selected.author)} · ${esc(selected.publisher)} · ${esc(selected.year)}</p>
        <p>${esc(selected.blurb)}</p>
        <div class="links">
          <a href="${esc(ydpUrl(selected.title))}" target="_blank" rel="noreferrer">永登浦区立图书馆</a>
          <a href="${esc(seoulUrl(selected.title))}" target="_blank" rel="noreferrer">首尔图书馆</a>
          <a href="${esc(selected.sourceUrl)}" target="_blank" rel="noreferrer">来源</a>
        </div>
        <label class="toggle"><input type="checkbox" id="read-toggle" ${mark.read ? "checked" : ""}> ${mark.read ? "已读" : "标为已读"}</label>
        ${
          mark.read
            ? `<label class="date-field">认证日（年-月-日，可改）<input type="date" id="date-inp" value="${esc(mark.completedAt || "")}"></label>`
            : ""
        }
        <div class="star-row"><span class="muted">评分</span>${stars}</div>
        <div style="margin-top:12px"><button type="button" class="close-btn" data-close>关闭</button></div>
      </div>
    </div>
  `;
  const tog = document.getElementById("read-toggle");
  if (tog) {
    tog.addEventListener("change", () => {
      const value = tog.checked;
      patch(selected.id, { read: value, completedAt: value ? mark.completedAt || todaySeoul() : mark.completedAt });
    });
  }
  const dateInp = document.getElementById("date-inp");
  if (dateInp) {
    dateInp.addEventListener("change", () => {
      patch(selected.id, { completedAt: dateInp.value });
    });
  }
  el.querySelectorAll("[data-star]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const star = Number(btn.getAttribute("data-star"));
      patch(selected.id, { rating: mark.rating === star ? 0 : star });
    });
  });
  const close = el.querySelector("[data-close]");
  if (close) close.addEventListener("click", () => { state.selectedId = null; lastScrolledId = null; render(); });
  if (lastScrolledId !== selected.id) {
    lastScrolledId = selected.id;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function render() {
  const filtered = getFiltered();
  const libList = getLibList();
  const doneBooks = BOOKS.filter((b) => marks[b.id] && marks[b.id].read);
  const learningBooks = BOOKS.filter((b) => !(marks[b.id] && marks[b.id].read));
  const months = lastTwelveMonths();
  const monthCounts = months.map((m) => doneBooks.filter((b) => ((marks[b.id] && marks[b.id].completedAt) || "").startsWith(m.key)).length);
  const textbookCount = BOOKS.filter((b) => b.source === "textbook").length;
  const agencyCount = BOOKS.filter((b) => b.source === "agency").length;

  renderMetrics(filtered, libList, doneBooks.length, textbookCount, agencyCount);
  document.querySelectorAll("#view-tabs [data-view]").forEach((btn) => {
    btn.classList.toggle("is-on", btn.getAttribute("data-view") === state.view);
  });
  document.getElementById("shelf-view").hidden = state.view !== "shelf";
  document.getElementById("library-view").hidden = state.view !== "library";
  if (state.view === "shelf") renderShelf(filtered);
  else renderLibrary(libList, doneBooks.length, learningBooks.length, months, monthCounts);
  renderDetail();
  renderSyncBar();
}

function bindShell() {
  fillSelect(document.getElementById("source-sel"), SOURCE_OPTS, state.source);
  fillSelect(document.getElementById("genre-sel"), GENRE_OPTS, state.genre);
  fillSelect(document.getElementById("read-sel"), READ_OPTS, state.readFilter);

  document.getElementById("view-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (!btn) return;
    state.view = btn.getAttribute("data-view");
    state.selectedId = null;
    render();
  });
  document.getElementById("grade-seg").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-grade]");
    if (!btn) return;
    state.grade = btn.getAttribute("data-grade");
    state.page = 0;
    render();
  });
  document.getElementById("source-sel").addEventListener("change", (e) => {
    state.source = e.target.value;
    state.page = 0;
    render();
  });
  document.getElementById("genre-sel").addEventListener("change", (e) => {
    state.genre = e.target.value;
    state.page = 0;
    render();
  });
  document.getElementById("read-sel").addEventListener("change", (e) => {
    state.readFilter = e.target.value;
    state.page = 0;
    render();
  });
  document.getElementById("query-inp").addEventListener("input", (e) => {
    state.query = e.target.value;
    state.page = 0;
    render();
    const inp = document.getElementById("query-inp");
    inp.focus();
    const len = inp.value.length;
    inp.setSelectionRange(len, len);
  });
  document.getElementById("lib-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-libtab]");
    if (!btn) return;
    state.libTab = btn.getAttribute("data-libtab");
    render();
  });
  document.getElementById("month-sel").addEventListener("change", (e) => {
    state.monthFilter = e.target.value;
    render();
  });
  document.getElementById("lib-query").addEventListener("input", (e) => {
    state.libQuery = e.target.value;
    render();
    const inp = document.getElementById("lib-query");
    inp.focus();
    const len = inp.value.length;
    inp.setSelectionRange(len, len);
  });
  document.getElementById("bookshelf").addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    const pageBtn = e.target.closest("[data-page]");
    if (open) {
      state.selectedId = open.getAttribute("data-open");
      render();
    } else if (pageBtn && !pageBtn.disabled) {
      state.page = Number(pageBtn.getAttribute("data-page"));
      render();
    }
  });
  document.getElementById("lib-body").addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) {
      state.selectedId = open.getAttribute("data-open");
      render();
    }
  });

  const pageEl = document.querySelector(".page");
  const applyCols = () => {
    const w = pageEl.getBoundingClientRect().width;
    const next = w >= 720 ? 5 : w >= 520 ? 3 : 2;
    if (next !== state.cols) {
      state.cols = next;
      state.page = 0;
      if (BOOKS.length) render();
    }
  };
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(applyCols);
    ro.observe(pageEl);
  } else {
    window.addEventListener("resize", applyCols);
  }
  applyCols();
}

async function init() {
  try {
    const res = await fetch("books.json");
    if (!res.ok) throw new Error("books.json " + res.status);
    BOOKS = await res.json();
  } catch (err) {
    document.getElementById("metrics").innerHTML = `<div class="callout warn"><strong>书单加载失败</strong><p>${esc(err.message)}</p></div>`;
    return;
  }
  loadMarks();
  saveMarks();
  loadSyncToken();
  bindShell();
  bindSyncBar();
  render();
  if (syncToken) pullAndMerge();
}

init();
