"use strict";
// ForeverGold terminal: состояние, верхняя панель, вотчлист, график предмета, правая колонка, клавиатура.

const S = {
	status: null,
	markets: null,
	instruments: [],
	instrumentsErr: null,
	byId: new Map(),
	sel: store.get("sel", null),
	item: null,          // ответ /api/item для выбранного диапазона
	itemErr: null,
	fc: null,            // прогноз выбранного предмета
	week: null,          // 7д ряд для сезонности
	range: store.get("range", "7d"),
	mode: store.get("mode", "line"),
	log: store.get("log", false),
	ov: Object.assign({ band: true, medians: true, corridor: true, forecast: true, own: true }, store.get("ov", {})),
	wlSort: store.get("wlSort", { key: null, dir: -1 }),
	wlFilter: "",
	wlCheap: false,
	wlCursor: -1,
	chart: null,
	docs: new Map(),     // кеш документов AHledger: kind → {doc, fetched, at}
	loadToken: 0,
};

const RANGES = [["24h", "24ч"], ["7d", "7д"], ["30d", "30д"], ["90d", "90д"]];
const LAUNCH = new Date(2026, 10, 5).getTime() / 1000; // 5 ноября

// ---------- Загрузка общих данных ----------

async function loadStatus() {
	try {
		S.status = await api("/api/status");
	} catch (e) {
		S.status = null;
	}
	renderTop();
	renderBanner();
}

async function loadMarkets() {
	try { S.markets = await api("/api/markets"); } catch { S.markets = null; }
	renderMarket();
}

async function loadInstruments() {
	try {
		const list = await api("/api/instruments?limit=300");
		S.instruments = Array.isArray(list) ? list : [];
		S.instrumentsErr = null;
	} catch (e) {
		S.instruments = [];
		S.instrumentsErr = e.status === 404 ? "Демон пока не отдаёт список инструментов (нужна новая версия)." : "Не удалось загрузить вотчлист: " + e.message;
	}
	S.byId = new Map(S.instruments.map(x => [x.itemId, x]));
	renderWatchlist();
	if (!S.sel && S.instruments.length) selectItem(S.instruments[0].itemId);
	else if (S.item) renderItemHead();
	if (!S._tabOnce || currentTab === "flips" || currentTab === "overview") { S._tabOnce = true; refreshTab(); }
}

function getDoc(kind, force) {
	const c = S.docs.get(kind);
	if (c && !force && (c.promise || Date.now() - c.at < 5 * 60 * 1000)) return c.promise || Promise.resolve(c);
	const p = apiDoc(kind).then(r => { const v = { ...r, at: Date.now() }; S.docs.set(kind, v); return v; })
		.catch(e => { S.docs.delete(kind); throw e; });
	S.docs.set(kind, { promise: p, at: Date.now() });
	return p;
}

// ---------- Верхняя панель ----------

function freshness() {
	const st = S.status;
	if (!st) return { cls: "bad", text: "демон недоступен", title: "Нет ответа от /api/status" };
	if (/not open/i.test(st.marketStatus || "")) return { cls: "off", text: "рынок не открыт", title: "Для этого рынка ещё нет цен" };
	const t = toSec(st.pricesAsOf);
	if (!t) return { cls: "bad", text: "нет сканов", title: "Таблица цен пуста" };
	const age = nowSec() - t;
	return {
		cls: age > 6 * 3600 ? "bad" : age > 3600 ? "warn" : "ok",
		text: "скан " + ago(t),
		title: "Последний снимок цен: " + fmtDate(t) + (age > 6 * 3600 ? ". Данные старше 6 ч, сигналы приглушены." : ""),
	};
}

function isStale() {
	const t = S.status && toSec(S.status.pricesAsOf);
	return !t || nowSec() - t > 6 * 3600;
}

function renderTop() {
	const f = freshness();
	const pill = $("#fresh");
	pill.className = "pill fresh " + f.cls;
	pill.title = f.title;
	pill.innerHTML = `<span class="dot"></span>${esc(f.text)}`;
	document.body.classList.toggle("stale", isStale());
	const st = S.status;
	const jobs = st && st.jobs ? Object.values(st.jobs) : [];
	const errs = jobs.filter(j => j && j.error);
	const d = $("#daemon");
	d.className = "dstat " + (!st ? "bad" : errs.length ? "warn" : "ok");
	d.title = !st ? "Демон не отвечает" : errs.length ? "Ошибки задач:\n" + errs.map(j => j.error).join("\n") : "Демон работает" + (st.wowPath ? "\nИгра: " + st.wowPath : "\nПапка игры не найдена");
	d.innerHTML = `<span class="dot"></span>демон`;
	renderMarket();
}

function marketLabel(id) {
	const m = (S.markets || []).find(x => x.id === id);
	if (m) return m.label;
	if (S.status && S.status.marketLabel && S.status.market === id) return S.status.marketLabel;
	return (id || "").replace(/^forever\./, "").split(".").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}

function renderMarket() {
	const cur = S.status && S.status.market;
	const btn = $("#mkt-btn");
	btn.innerHTML = `<span class="mkt-l">Рынок</span><span class="mkt-v">${esc(cur ? marketLabel(cur) : "—")}</span><svg class="chev" viewBox="0 0 12 12"><path d="M3 4.5 6 7.5 9 4.5"/></svg>`;
	btn.disabled = !S.markets;
	btn.title = S.markets ? "Сменить рынок" : "Список рынков недоступен";
	const menu = $("#mkt-menu");
	if (!S.markets) { menu.innerHTML = ""; return; }
	const groups = {};
	for (const m of S.markets) (groups[m.region || "—"] ||= []).push(m);
	menu.innerHTML = Object.entries(groups).map(([g, list]) => `<div class="mm-g">${esc(g)}</div>` + list.map(m =>
		`<button class="mm-i${m.id === cur ? " on" : ""}" data-id="${esc(m.id)}"><span class="dot ${m.open ? "ok" : "off"}"></span>${esc(m.label)}<span class="mm-s">${m.open ? "" : "не открыт"}</span></button>`).join("")).join("");
}

async function switchMarket(id) {
	$("#mkt").classList.remove("open");
	if (!id || (S.status && id === S.status.market)) return;
	toast("Переключаю рынок на " + marketLabel(id) + "…");
	try {
		await api("/api/market", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ market: id }) });
	} catch (e) {
		toast("Не удалось переключить рынок: " + e.message, "bad");
		return;
	}
	S.docs.clear();
	S.sel = null;
	S.item = null;
	await loadStatus();
	await loadInstruments();
	toast("Рынок: " + marketLabel(id) + ". Идёт синк, данные подтянутся через минуту.");
	setTimeout(() => { loadStatus(); loadInstruments(); }, 20000);
}

function renderBanner() {
	const b = $("#banner");
	const st = S.status;
	const now = nowSec();
	const msgs = [];
	if (st && /not open/i.test(st.marketStatus || "")) msgs.push(["closed", `Рынок ${esc(st.marketLabel || st.market)} ещё не открыт: цен, графиков и сигналов пока нет. Демон начнёт копить историю сам с первыми сканами.`]);
	if (now >= LAUNCH && now < LAUNCH + 21 * 86400) msgs.push(["warn", "Свежий сервер: первые недели после запуска 5 ноября цены быстро падают. «Дёшево к медиане 30д» может оказаться новой нормой."]);
	b.innerHTML = msgs.map(([c, t]) => `<div class="banner ${c}">${t}</div>`).join("");
	document.getElementById("app").classList.toggle("has-banner", msgs.length > 0);
}

let toastTimer;
function toast(text, cls = "") {
	const t = $("#toast");
	t.className = "toast show " + cls;
	t.textContent = text;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.remove("show"), 4200);
}

// ---------- Поиск ----------

const search = { results: [], cursor: -1, q: "" };

function localSearch(q) {
	const s = q.toLowerCase();
	return S.instruments.filter(x => itemName(x).toLowerCase().includes(s) || (x.nameEn || "").toLowerCase().includes(s) || String(x.itemId) === s);
}

const runSearch = debounce(async (q) => {
	search.q = q;
	if (!q.trim()) { search.results = []; renderSearch(); return; }
	let list = localSearch(q.trim()).slice(0, 12);
	renderSearch(list, true);
	try {
		const remote = await api("/api/search?q=" + encodeURIComponent(q.trim()));
		if (search.q !== q) return;
		const seen = new Set(list.map(x => x.itemId));
		list = list.concat((remote || []).filter(x => !seen.has(x.itemId))).slice(0, 30);
	} catch { /* только локальный поиск */ }
	if (search.q === q) renderSearch(list, false);
}, 140);

function renderSearch(list, pending) {
	const box = $("#sdrop");
	if (list) search.results = list;
	if (!search.q.trim()) { box.classList.remove("open"); return; }
	search.cursor = Math.min(search.cursor, search.results.length - 1);
	box.classList.add("open");
	if (!search.results.length) {
		box.innerHTML = `<div class="sd-empty">${pending ? "Ищу…" : "Ничего не найдено. Можно искать по-русски, по-английски или по ID."}</div>`;
		return;
	}
	box.innerHTML = search.results.map((x, i) => `<div class="sd-i${i === search.cursor ? " cur" : ""}" data-id="${x.itemId}">
		${iconHTML(x, 24)}<div class="sd-n">${nameHTML(x)}<span class="sd-en">${esc(x.nameEn && x.nameEn !== itemName(x) ? x.nameEn + " · " : "")}${x.itemId}</span></div>
		<div class="sd-p">${money(x.min)}</div><div class="sd-c ${signCls(x.ind && x.ind.change24h)}">${pct(x.ind && x.ind.change24h)}</div></div>`).join("");
}

function pickSearch(id) {
	$("#q").value = "";
	search.q = "";
	$("#sdrop").classList.remove("open");
	$("#q").blur();
	if (id) openItem(Number(id));
}

// ---------- Вотчлист ----------

const WL_COLS = [
	{ key: "name", title: "Инструмент", get: x => itemName(x) },
	{ key: "min", title: "Мин", num: true, get: x => x.min },
	{ key: "chg", title: "Δ24ч", num: true, get: x => x.ind && x.ind.change24h },
	{ key: "spark", title: "7д", num: true, get: x => spark7(x) },
	{ key: "dos", title: "DoS", num: true, get: x => x.ind && x.ind.dos },
];

function spark7(x) {
	const s = (x.spark || []).filter(p => isNum(p[1]) && p[1] > 0);
	return s.length > 1 ? s[s.length - 1][1] / s[0][1] - 1 : null;
}

function wlRows() {
	const f = S.wlFilter.trim().toLowerCase();
	let rows = S.instruments;
	if (f) rows = rows.filter(x => itemName(x).toLowerCase().includes(f) || (x.nameEn || "").toLowerCase().includes(f) || String(x.itemId) === f);
	if (S.wlCheap) rows = rows.filter(x => x.ind && x.ind.discount >= 0.15);
	const { key, dir } = S.wlSort;
	if (key) {
		const col = WL_COLS.find(c => c.key === key);
		rows = [...rows].sort((a, b) => {
			const x = col.get(a), y = col.get(b);
			if (x == null && y == null) return 0;
			if (x == null) return 1;
			if (y == null) return -1;
			return (typeof x === "string" ? x.localeCompare(y, "ru") : x - y) * dir;
		});
	}
	return rows;
}

function dosCls(v) {
	if (!isNum(v)) return "";
	return v < 1 ? "up" : v > 10 ? "down" : "";
}

function fmtDos(v) {
	if (!isNum(v)) return "—";
	if (v >= 100) return "99+";
	return v < 10 ? nf1.format(v) : nf0.format(v);
}

let wlView = [];
function renderWatchlist() {
	const head = $("#wl-head");
	const hb = (k) => {
		const c = WL_COLS.find(x => x.key === k);
		const on = S.wlSort.key === k;
		return `<button class="wh ${c.num ? "num" : ""} c-${k}${on ? " on" : ""}" data-k="${k}">${c.title}${on ? `<span class="ar">${S.wlSort.dir > 0 ? "▲" : "▼"}</span>` : ""}</button>`;
	};
	head.innerHTML = hb("name") + hb("spark") + `<div class="wh-2">${hb("min")}<span class="sl">·</span>${hb("chg")}</div>` + hb("dos");
	const list = $("#wl-list");
	$("#wl-count").textContent = S.instruments.length ? num(S.instruments.length) : "";
	if (S.instrumentsErr) { list.innerHTML = stateHTML("error", "Вотчлист недоступен", esc(S.instrumentsErr)); return; }
	if (!S.instruments.length) {
		const closed = S.status && /not open/i.test(S.status.marketStatus || "");
		list.innerHTML = S.status ? stateHTML(closed ? "closed" : "empty", closed ? "Рынок не открыт" : "Пока пусто", closed ? "Инструменты появятся после первых сканов." : "Демон ещё не набрал ликвидных предметов. Нажмите «Синк» или подождите до 15 минут.") : skeletonRows(14, 4);
		return;
	}
	wlView = wlRows();
	if (!wlView.length) { list.innerHTML = stateHTML("empty", "Ничего не подходит", "Сбросьте фильтр."); return; }
	const scroll = list.scrollTop;
	list.innerHTML = wlView.map((x, i) => {
		const ind = x.ind || {};
		const cheap = isNum(ind.discount) && ind.discount >= 0.15;
		const ttl = `${itemName(x)}${x.nameEn && x.nameEn !== itemName(x) ? " · " + x.nameEn : ""}\nСкидка к 30д: ${pct(ind.discount, 0)}\nДней запаса: ${fmtDos(ind.dos)}\nПродаж в день: ${isNum(x.salesPerDay) && x.salesPerDay > 0 ? num(x.salesPerDay, 1) : "нет оценки"}`;
		return `<div class="wr${x.itemId === S.sel ? " sel" : ""}${i === S.wlCursor ? " cur" : ""}" data-id="${x.itemId}" data-i="${i}" title="${esc(ttl)}">
			<div class="c-name">${iconHTML(x, 26)}<div class="wn"><div class="wn-1">${nameHTML(x)}</div><div class="wn-2">${cheap ? `<span class="tag cheap${ind.discount >= 0.3 ? " strong" : ""}" title="Дёшево: скидка к медиане 30д">дёшево −${Math.round(ind.discount * 100)}%</span>` : ""}<span class="wq">${isNum(x.qty) ? compact(x.qty) + " шт" : ""}</span></div></div></div>
			<div class="c-spark"><canvas data-i="${i}"></canvas></div>
			<div class="num c-px"><div class="c-min">${money(x.min, { compact: true })}</div><div class="c-chg ${signCls(ind.change24h)}">${pct(ind.change24h)}</div></div>
			<div class="num c-dos"><span class="dos ${dosCls(ind.dos)}" title="Дней запаса">${fmtDos(ind.dos)}</span></div>
		</div>`;
	}).join("");
	list.scrollTop = scroll;
	requestAnimationFrame(() => {
		list.querySelectorAll("canvas[data-i]").forEach(cv => drawSpark(cv, wlView[+cv.dataset.i] && wlView[+cv.dataset.i].spark));
	});
}

function moveWlCursor(delta) {
	if (!wlView.length) return;
	let i = S.wlCursor;
	if (i < 0) i = Math.max(0, wlView.findIndex(x => x.itemId === S.sel));
	else i += delta;
	i = Math.max(0, Math.min(wlView.length - 1, i));
	S.wlCursor = i;
	const list = $("#wl-list");
	list.querySelectorAll(".wr.cur").forEach(r => r.classList.remove("cur"));
	const row = list.querySelector(`.wr[data-i="${i}"]`);
	if (row) { row.classList.add("cur"); row.scrollIntoView({ block: "nearest" }); }
}

// ---------- Предмет ----------

function selectItem(id, opts = {}) {
	if (!id) return;
	S.sel = id;
	store.set("sel", id);
	$("#wl-list").querySelectorAll(".wr").forEach(r => r.classList.toggle("sel", Number(r.dataset.id) === id));
	S.fc = null; S.week = null;
	loadItem(true);
	void opts;
}

async function loadItem(newItem) {
	const id = S.sel;
	const token = ++S.loadToken;
	if (newItem) {
		S.item = null;
		S.itemErr = null;
		renderItemHead();
		renderCenterLoading();
		renderSide();
	} else renderCenterLoading(true);
	let data, err = null;
	try {
		data = await api(`/api/item/${id}?range=${S.range}`);
	} catch (e) { err = e; }
	if (token !== S.loadToken) return;
	S.item = data ? normalizeItem(data, id) : null;
	S.itemErr = err;
	if (newItem || !S.fc) {
		api(`/api/item/${id}/forecast`).then(f => { if (S.sel === id) { S.fc = f || { ok: false }; renderChart(); renderSide(); } })
			.catch(() => { if (S.sel === id) { S.fc = { ok: false, note: "прогноз недоступен" }; renderToolbar(); } });
	}
	if (S.range === "7d") S.week = S.item && S.item.series;
	else if (!S.week) api(`/api/item/${id}?range=7d`).then(w => { if (S.sel === id) { S.week = (w && w.series) || []; renderSide(); } }).catch(() => {});
	renderItemHead();
	renderChart();
	renderSide();
	if (currentTab === "calc") refreshTab();
}

// Старый формат ответа (без item/ind/from/to) приводим к контракту, чтобы экран не падал.
function normalizeItem(d, id) {
	const inst = S.byId.get(id) || {};
	const lat = d.latest || {};
	const meta = d.item || { itemId: id, name: lat.name || inst.name, nameEn: inst.nameEn, quality: inst.quality, icon: inst.icon, itemClass: inst.itemClass };
	if (!meta.name) meta.name = inst.name || "";
	if (!isNum(meta.itemId)) meta.itemId = id;
	if (!isNum(lat.salesPerDay) && isNum(lat.sales10)) lat.salesPerDay = lat.sales10 / 10;
	return {
		...d, item: meta, latest: d.latest ? lat : null, ind: d.ind || inst.ind || {},
		series: Array.isArray(d.series) ? d.series : [], snapshots: Array.isArray(d.snapshots) ? d.snapshots : [],
		own: Array.isArray(d.own) ? d.own : [], book: Array.isArray(d.book) ? d.book : [],
	};
}

function histInfo() {
	const it = S.item;
	const hd = it && it.ind && it.ind.histDays;
	return isNum(hd) ? hd : null;
}

function renderItemHead() {
	const h = $("#ihead");
	const id = S.sel;
	const inst = S.byId.get(id);
	const it = S.item;
	const meta = (it && it.item) || inst;
	if (!id) { h.innerHTML = ""; return; }
	if (!meta) { h.innerHTML = `<div class="ih-l"><span class="skel" style="width:38px;height:38px"></span><div class="ih-t"><span class="skel" style="width:200px;height:16px"></span><span class="skel" style="width:140px"></span></div></div>`; return; }
	const lat = (it && it.latest) || inst || {};
	const ind = (it && it.ind) || (inst && inst.ind) || {};
	const sub = [meta.nameEn && meta.nameEn !== itemName(meta) ? esc(meta.nameEn) : null, "ID " + id, meta.itemClass ? esc(meta.itemClass) : null, meta.itemSubclass ? esc(meta.itemSubclass) : null, isNum(meta.level) && meta.level ? "ур. " + meta.level : null].filter(Boolean).join('<span class="sep">·</span>');
	const chg = ind.change24h;
	const disc = ind.discount;
	h.innerHTML = `
	<div class="ih-l">
		${iconHTML(meta, 38)}
		<div class="ih-t">
			<div class="ih-name">${nameHTML(meta)}</div>
			<div class="ih-sub">${sub}</div>
		</div>
	</div>
	<div class="ih-q">
		<div class="ih-price">${money(lat.min)}</div>
		<div class="ih-chg ${signCls(chg)}">${isNum(chg) ? (chg > 0 ? "▲ " : chg < 0 ? "▼ " : "") + pct(chg) : "—"}<span class="ih-k">за 24ч</span></div>
	</div>
	<div class="ih-kv">
		<div><span class="ih-k">Медиана</span>${money(lat.median, { compact: true })}</div>
		<div><span class="ih-k">Медиана 30д</span>${isNum(lat.median30) ? money(lat.median30, { compact: true }) : '<span class="na">—</span>'}</div>
		<div><span class="ih-k">Скидка к 30д</span><span class="n ${discCls(disc)}">${pct(disc, 1, false)}</span></div>
		<div><span class="ih-k">Продаж/день</span><span class="n">${isNum(lat.salesPerDay) && lat.salesPerDay > 0 ? num(lat.salesPerDay, 1) : '<span class="na">—</span>'}</span></div>
	</div>`;
}

function discCls(v) {
	if (!isNum(v)) return "na";
	if (v >= 0.3) return "cheap strong";
	if (v >= 0.15) return "cheap";
	if (v < 0) return "muted";
	return "";
}

function renderToolbar() {
	const tb = $("#itool");
	const cand = S.item ? candlesAvailable(S.item, S.range) : { ok: false, why: "Нет данных" };
	const fcAllowed = S.range === "24h" || S.range === "7d";
	const fcReason = !fcAllowed ? "Прогноз показывается на 24ч и 7д" : !S.fc ? "Загружаю прогноз…" : !S.fc.ok ? "Прогноза нет: " + (S.fc.note || "мало истории") : "Прогноз демона: тренд и 80% полоса";
	const chip = (k, label, sw, dis, title) => `<button class="chip${S.ov[k] && !dis ? " on" : ""}" data-ov="${k}"${dis ? " disabled" : ""} title="${esc(title || "")}">${sw}${label}</button>`;
	const candOn = S.mode === "candles" && cand.ok;
	tb.innerHTML = `
	<div class="seg" role="tablist">${RANGES.map(([k, l], i) => `<button class="${S.range === k ? "on" : ""}" data-range="${k}" title="Клавиша ${i + 1}">${l}</button>`).join("")}</div>
	<div class="seg">
		<button class="${!candOn ? "on" : ""}" data-mode="line" title="Линия min и медианы">Линия</button>
		<button class="${candOn ? "on" : ""}" data-mode="candles"${cand.ok ? "" : " disabled"} title="${esc(cand.why)}">Свечи</button>
	</div>
	<div class="seg">
		<button class="${!S.log ? "on" : ""}" data-log="0" title="Линейная шкала">Лин</button>
		<button class="${S.log ? "on" : ""}" data-log="1" title="Логарифмическая шкала">Лог</button>
	</div>
	<div class="chips">
		${chip("band", "p25–p75", '<span class="sw band"></span>', false, "Полоса между 25-м и 75-м перцентилем цен лотов")}
		${chip("medians", "M7 · M30", '<span class="sw dash m7"></span>', false, "Медиана 7 и 30 дней (последнее значение)")}
		${chip("corridor", "Коридор 30д", '<span class="sw corr"></span>', false, "Минимум и максимум min-цены за 30 дней")}
		${chip("forecast", "Прогноз", '<span class="sw dash fc"></span>', !fcAllowed || !(S.fc && S.fc.ok), fcReason)}
		${chip("own", "Мои сканы", '<span class="sw diamond"></span>', false, "Минимум в ваших сканах аддоном")}
	</div>
	${candOn ? `<div class="tb-note">${esc(cand.why)}</div>` : ""}`;
}

function renderCenterLoading(keep) {
	renderToolbar();
	if (keep && S.chart) { $("#ichart").classList.add("loading"); return; }
	if (S.chart) { S.chart.destroy(); S.chart = null; }
	$("#inotice").innerHTML = "";
	$("#ichart").innerHTML = `<div class="chart-skel"><div class="skel-chart"></div></div>`;
}

function thinNotice() {
	const it = S.item;
	if (!it) return "";
	const hd = histInfo();
	const msgs = [];
	if (isNum(hd) && hd < 1) {
		const n = it.series.length + it.snapshots.length;
		const hours = Math.max(1, Math.round(hd * 24));
		msgs.push(["thin", `<b>${num(n)} ${plural(n, "скан", "скана", "сканов")} за ${hours} ч.</b> Это только точки: медиан 7д/30д и прогноза пока нет.`]);
	} else if (isNum(hd) && hd < 7) {
		msgs.push(["thin", `<b>История ${nf1.format(hd)} дн.</b> Показатели 7д/30д и прогноз появятся после 7 дней наблюдений.`]);
	} else if (isNum(hd) && hd < 14 && S.fc && S.fc.ok && S.ov.forecast && (S.range === "24h" || S.range === "7d")) {
		msgs.push(["info", `<b>Прогноз с низкой уверенностью:</b> история ${nf0.format(hd)} дн., для профиля по часам нужно ≥14.`]);
	}
	const lastT = it.latest && it.latest.t;
	if (lastT && nowSec() - lastT > 6 * 3600 && S.range === "24h" && !it.series.some(p => p.t > nowSec() - 86400))
		msgs.push(["thin", `<b>За последние 24 ч сканов нет.</b> Последний — ${ago(lastT)}. Смотрите 7д или 30д.`]);
	return msgs.map(([c, t]) => `<div class="notice ${c}">${t}</div>`).join("");
}

function renderChart() {
	renderToolbar();
	const box = $("#ichart");
	box.classList.remove("loading");
	if (S.chart) { S.chart.destroy(); S.chart = null; }
	const it = S.item;
	if (S.itemErr) {
		$("#inotice").innerHTML = "";
		box.innerHTML = S.itemErr.status === 404 ? stateHTML("empty", "Предмет не найден", "Демон ничего не знает об этом предмете на текущем рынке.") : stateHTML("error", "Ошибка загрузки", esc(S.itemErr.message));
		return;
	}
	if (!it) return;
	$("#inotice").innerHTML = thinNotice();
	const hasData = it.series.length || it.own.length || it.snapshots.length;
	if (!hasData) {
		const closed = S.status && /not open/i.test(S.status.marketStatus || "");
		box.innerHTML = closed ? stateHTML("closed", "Рынок ещё не открыт", "Графиков нет, пока по этому рынку нет ни одного скана.")
			: it.latest ? stateHTML("empty", "Нет точек за " + RANGES.find(r => r[0] === S.range)[1], "За этот период сканов нет. Попробуйте диапазон шире: клавиши 1–4.")
				: stateHTML("empty", "Нет сканов", "AHledger и ваш аддон ещё не видели этот предмет на аукционе. Сделайте полный скан в игре и /reload: демон заберёт данные.");
		return;
	}
	const hd = histInfo();
	try {
		S.chart = renderItemChart(box, it, S.fc, {
			range: S.range, mode: S.mode, log: S.log, band: S.ov.band, medians: S.ov.medians, corridor: S.ov.corridor,
			forecast: S.ov.forecast && !(isNum(hd) && hd < 1), own: S.ov.own, lowConfidence: isNum(hd) && hd < 14, pointsOnly: isNum(hd) && hd < 1,
		});
	} catch (e) {
		console.error(e);
		box.innerHTML = stateHTML("error", "Не удалось построить график", esc(e.message));
	}
}

// ---------- Правая колонка ----------

function bookModel(it) {
	const book = (it.book || []).filter(b => isNum(b.price) && isNum(b.qty)).sort((a, b) => a.price - b.price);
	let cq = 0, cc = 0;
	const rows = book.map(b => { cq += b.qty; cc += b.price * b.qty; return { ...b, cq, cc }; });
	let gapI = -1, gap = 0;
	for (let i = 1; i < rows.length; i++) {
		const g = rows[i].price / rows[i - 1].price - 1;
		if (g > gap) { gap = g; gapI = i; }
	}
	const gap1 = rows.length > 1 ? rows[1].price / rows[0].price - 1 : null;
	return { rows, gapI, gap, gap1, totalQ: cq };
}

function renderSide() {
	const side = $("#side");
	const it = S.item;
	if (!S.sel) { side.innerHTML = stateHTML("empty", "Выберите предмет", "в вотчлисте слева или через поиск <kbd>/</kbd>"); return; }
	if (!it) {
		side.innerHTML = S.itemErr ? "" : `<section class="sec"><div class="sec-h">Стакан</div>${skeletonRows(8, 4)}</section><section class="sec"><div class="sec-h">Показатели</div>${skeletonRows(6, 2)}</section>`;
		return;
	}
	const sc = side.scrollTop;
	side.innerHTML = bookHTML(it) + statsHTML(it) + seasonHTML();
	side.scrollTop = sc;
}

function bookHTML(it) {
	const bm = bookModel(it);
	const age = it.bookTime ? nowSec() - it.bookTime : null;
	const old = age !== null && age > 2 * 3600;
	const m30 = it.latest && it.latest.median30;
	const head = `<div class="sec-h"><span>Стакан</span><span class="sec-m${old ? " warn" : ""}">${it.bookTime ? "свой скан " + ago(it.bookTime) : ""}</span></div>`;
	if (!bm.rows.length) {
		return `<section class="sec book">${head}${stateHTML("wait", "Своего скана нет", "Стакан берётся из полного скана аддоном. Откройте аукцион в игре, сделайте скан и /reload.")}</section>`;
	}
	const maxQ = bm.totalQ || 1;
	const LIMIT = 16;
	let out = "";
	let markerDone = !isNum(m30);
	const marker = `<div class="bk-mk"><span>медиана 30д · ${money(m30, { compact: true })}</span></div>`;
	bm.rows.slice(0, LIMIT).forEach((r, i) => {
		if (!markerDone && r.price > m30) { out += marker; markerDone = true; }
		const isGap = i === bm.gapI && bm.gap > 0.05;
		out += `<div class="bk-r${isGap ? " gap" : ""}${i === 0 ? " best" : ""}" style="--dp:${(r.cq / maxQ * 100).toFixed(1)}%">
			<span class="num p">${isGap ? `<span class="gap-t" title="Самый большой разрыв в стакане: этот уровень дороже предыдущего на ${pct(bm.gap, 0)}">+${Math.round(bm.gap * 100)}%</span>` : ""}${money(r.price)}</span>
			<span class="num">${num(r.qty)}</span><span class="num d">${num(r.cq)}</span><span class="num">${money(r.cc, { compact: true })}</span></div>`;
	});
	if (!markerDone && bm.rows.length <= LIMIT) out += marker;
	const more = bm.rows.length > LIMIT ? `<div class="book-more">ещё ${bm.rows.length - LIMIT} ${plural(bm.rows.length - LIMIT, "уровень", "уровня", "уровней")} · всего ${num(bm.totalQ)} шт на ${money(bm.rows[bm.rows.length - 1].cc, { compact: true })}</div>` : "";
	return `<section class="sec book${old ? " old" : ""}">${head}
		${old ? `<div class="notice thin sm">Скан старше 2 ч: стакан мог измениться.</div>` : ""}
		<div class="bk"><div class="bk-r bk-h"><span class="num">Цена</span><span class="num">Шт</span><span class="num" title="Накопленное количество">Σ шт</span><span class="num" title="Сколько стоит выкупить всё до этого уровня включительно">Σ выкуп</span></div>${out}</div>${more}</section>`;
}

function statsHTML(it) {
	const l = it.latest || {};
	const ind = it.ind || {};
	const last = [...it.series].reverse().find(p => isNum(p.p25) && p.p25 > 0) || {};
	const lastAny = it.series.length ? it.series[it.series.length - 1] : {};
	const hd = histInfo();
	const bm = bookModel(it);
	const need = (days) => `нужно ≥${days} дн. истории` + (isNum(hd) ? `, есть ${nf1.format(hd)}` : "");
	const cell = (k, v, cls = "", title = "", wide = false) => `<div class="st${wide ? " wide" : ""}" title="${esc(title)}"><div class="st-k">${k}</div><div class="st-v ${cls}">${v}</div></div>`;
	const na = (t) => `<span class="na" title="${esc(t)}">—</span>`;
	const m = (v, t) => (isNum(v) ? money(v, { compact: true }) : na(t || need(7)));

	const z = ind.z;
	const zCls = !isNum(z) ? "" : z <= -2 ? "cheap strong" : z <= -1 ? "cheap" : z >= 2 ? "dear" : "";
	const rp = ind.rangePos;
	const rpCls = !isNum(rp) ? "" : rp < 0.15 ? "cheap" : rp > 0.85 ? "dear" : "";
	const mom = ind.momentum;
	const knife = isNum(mom) && mom < -0.1 && isNum(ind.discount) && ind.discount > 0;
	const vol = ind.volatility;
	const volT = !isNum(vol) ? null : vol < 0.05 ? "низкая" : vol < 0.15 ? "средняя" : "высокая";
	const liq = ind.liquidity;
	const gauge = (v, cls) => `<span class="gauge"><span class="g-f ${cls}" style="width:${(Math.max(0, Math.min(1, v)) * 100).toFixed(1)}%"></span></span>`;
	const noSales = !(isNum(l.salesPerDay) && l.salesPerDay > 0);

	return `<section class="sec stats"><div class="sec-h"><span>Показатели</span><span class="sec-m">${isNum(hd) ? "история " + (hd < 1 ? Math.max(1, Math.round(hd * 24)) + " ч" : nf0.format(hd) + " дн") : ""}</span></div>
	<div class="sg">
		${cell("Мин", money(l.min))}
		${cell("Медиана", money(l.median))}
		${cell("p25 / p75", isNum(last.p25) ? money(last.p25, { compact: true }) + '<span class="sl">/</span>' + money(last.p75, { compact: true }) : na("нет перцентилей в последней точке"))}
		${cell("Медиана 7д / 30д", m(l.median7, need(7)) + '<span class="sl">/</span>' + m(l.median30, need(14)))}
		${cell("Мин / макс 30д", m(l.low30, need(14)) + '<span class="sl">/</span>' + m(l.high30, need(14)))}
		${cell("Скидка к 30д", isNum(ind.discount) ? pct(ind.discount, 1, false) : na(need(14)), discCls(ind.discount), "D = 1 − min / медиана30. ≥15% бирюзовый, ≥30% ярко-бирюзовый")}
		${cell("Количество", num(l.qty))}
		${cell("Лоты", num(lastAny.auctions || last.auctions))}
		${cell("Продаж в день", noSales ? na("AHledger пока не оценил продажи (мало последовательных сканов)") : num(l.salesPerDay, 1), "", "Оценка AHledger по последовательным сканам, занижена")}
		${cell("Дней запаса", isNum(ind.dos) ? fmtDos(ind.dos) : na("нет оценки продаж"), dosCls(ind.dos), "DoS = количество / продажи в день. <1 быстро уйдёт, >10 завал")}
		${cell("Робастный z", isNum(z) ? (z > 0 ? "+" : z < 0 ? "−" : "") + nf2.format(Math.abs(z)) : na(need(14)), zCls, "(min − медиана30) / (1,4826·MAD). ≤−2 сильный сигнал, −2…−1 слабый")}
		${cell("Моментум 7/30", isNum(mom) ? `${mom > 0.1 ? "↗ " : mom < -0.1 ? "↘ " : ""}${pct(mom)}` : na(need(14)), isNum(mom) && Math.abs(mom) > 0.1 ? signCls(mom) : "", "медиана7 / медиана30 − 1")}
		${cell("Положение в диапазоне 30д", isNum(rp) ? `<span class="n">${nf0.format(rp * 100)}%</span>${gauge(rp, rpCls)}` : na(need(14)), rpCls, "(min − мин30) / (макс30 − мин30). <15% низ, >85% верх: время выставлять свои запасы", true)}
		${cell("Волатильность", isNum(vol) ? `${volT} <span class="dim">${pct(vol, 0, false)}</span>` : na(need(14)), "", "σ лог-доходностей дневной медианы за 14 дней")}
		${cell("Ликвидность", isNum(liq) ? `<span class="n">${nf0.format(liq)}</span>${gauge(liq / 100, "liq")}` : na("нет оценки продаж"), "", "log10(продажи·медиана30) в шкале 0–100")}
		${cell("Разрыв над min", isNum(bm.gap1) ? pct(bm.gap1, 0) : na("нужен свой скан"), isNum(bm.gap1) && bm.gap1 > 0.15 ? "dear" : "", "(уровень2 − уровень1) / уровень1 по стакану. >15%: одинокий дешёвый лот перед стеной")}
		${cell("Цена у вендора", it.item && isNum(it.item.vendorSell) && it.item.vendorSell > 0 ? money(it.item.vendorSell) : na("неизвестна"))}
	</div>
	${knife ? `<div class="notice warn sm">Падающий нож: цена ниже медианы, но неделя падает (моментум ${pct(mom, 0)}).</div>` : ""}
	</section>`;
}

function seasonHTML() {
	const hd = histInfo();
	const grid = seasonality(S.week);
	const fc = S.fc;
	let body;
	if (!grid) {
		body = stateHTML("wait", "Мало данных", "Тепловая карта строится по часовому ряду за 7 дней.");
	} else {
		const color = (dv) => {
			const a = Math.min(1, Math.abs(dv) / 0.1);
			return dv < 0 ? `rgba(76,141,255,${(0.1 + a * 0.7).toFixed(2)})` : `rgba(240,80,110,${(0.1 + a * 0.7).toFixed(2)})`;
		};
		const order = [1, 2, 3, 4, 5, 6, 0];
		let cells = `<div class="hm-c hm-h"></div>` + [...Array(24).keys()].map(h => `<div class="hm-c hm-h">${h % 6 === 0 ? h : ""}</div>`).join("");
		for (const wd of order) {
			cells += `<div class="hm-c hm-wd">${WD_SHORT[wd]}</div>`;
			for (let h = 0; h < 24; h++) {
				const c = grid[wd][h];
				const st = c.d === null ? "" : `background:${color(c.d)}`;
				cells += `<div class="hm-c${c.n < 3 ? " dim" : ""}${c.d === null ? " empty" : ""}" style="${st}" title="${WD_SHORT[wd]} ${String(h).padStart(2, "0")}:00 · ${c.d === null ? "нет данных" : pct(c.d) + " к среднему"} · n=${c.n}"></div>`;
			}
		}
		body = `<div class="hm">${cells}</div>
		<div class="hm-lg"><span>−10%</span><span class="hm-scale"></span><span>+10%</span><span class="dim">n&lt;3 затемнено</span></div>`;
	}
	const slot = s => `${WD_SHORT[s.weekday]} ${String(s.hour).padStart(2, "0")}:00`;
	const fcLine = fc && fc.ok && fc.cheapestSlot && fc.dearestSlot ? `<div class="hm-fc">Модель: дешевле всего <b class="cheap">${slot(fc.cheapestSlot)}</b>, дороже <b class="dear">${slot(fc.dearestSlot)}</b></div>` : "";
	const low = isNum(hd) && hd < 14 ? `<div class="notice thin sm">История ${nf0.format(hd)} дн: сезонность ненадёжна, нужно ≥14.</div>` : "";
	return `<section class="sec season"><div class="sec-h"><span>Сезонность 24×7</span><span class="sec-m">min к среднему за 7д</span></div>${low}${body}${fcLine}</section>`;
}

// ---------- Нижняя панель ----------

let currentTab = store.get("tab", "flips");

function renderTabbar() {
	$("#tabbar").innerHTML = TABS.map(t => `<button class="tb${t.id === currentTab ? " on" : ""}" data-tab="${t.id}">${t.title}${t.exp ? '<span class="tb-x">β</span>' : ""}</button>`).join("") +
		`<span class="tb-sp"></span><span class="tb-meta" id="tab-meta"></span>
		<button class="icon-btn" id="bottom-size" title="Развернуть / свернуть панель"><svg viewBox="0 0 16 16"><path d="M4 10l4-4 4 4"/></svg></button>`;
}

function refreshTab() {
	const t = TABS.find(x => x.id === currentTab) || TABS[0];
	const body = $("#tabbody");
	if (typeof ovChart !== "undefined" && ovChart) { ovChart.destroy(); ovChart = null; }
	$("#tab-meta").innerHTML = "";
	try { t.render(body); } catch (e) { console.error(e); body.innerHTML = stateHTML("error", "Ошибка вкладки", esc(e.message)); }
}

function setTab(id) {
	currentTab = id;
	store.set("tab", id);
	renderTabbar();
	refreshTab();
}

// Открыть предмет из таблицы скринера или поиска.
function openItem(id) {
	if (!id) return;
	id = Number(id);
	selectItem(id);
	const row = $("#wl-list").querySelector(`.wr[data-id="${id}"]`);
	if (row) row.scrollIntoView({ block: "nearest" });
}

// ---------- События ----------

function bind() {
	$("#mkt-btn").addEventListener("click", (e) => { e.stopPropagation(); $("#mkt").classList.toggle("open"); });
	$("#mkt-menu").addEventListener("click", e => { const b = e.target.closest(".mm-i"); if (b) switchMarket(b.dataset.id); });
	document.addEventListener("click", e => {
		if (!e.target.closest("#mkt")) $("#mkt").classList.remove("open");
		if (!e.target.closest("#search")) $("#sdrop").classList.remove("open");
	});

	$("#sync").addEventListener("click", async () => {
		const b = $("#sync");
		b.classList.add("busy");
		b.disabled = true;
		try {
			await api("/api/sync", { method: "POST" });
			toast("Синк запущен. Обновлю данные через несколько секунд.");
			setTimeout(async () => { S.docs.clear(); await loadStatus(); await loadInstruments(); if (S.sel) loadItem(false); b.classList.remove("busy"); b.disabled = false; }, 5000);
		} catch (e) {
			toast("Синк не запустился: " + e.message, "bad");
			b.classList.remove("busy");
			b.disabled = false;
		}
	});

	const q = $("#q");
	q.addEventListener("input", () => { search.cursor = 0; runSearch(q.value); });
	q.addEventListener("focus", () => { if (q.value.trim()) renderSearch(); });
	q.addEventListener("keydown", e => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			search.cursor = Math.max(0, Math.min(search.results.length - 1, search.cursor + (e.key === "ArrowDown" ? 1 : -1)));
			renderSearch();
			const c = $("#sdrop .sd-i.cur"); if (c) c.scrollIntoView({ block: "nearest" });
		} else if (e.key === "Enter") {
			const r = search.results[Math.max(0, search.cursor)];
			if (r) pickSearch(r.itemId);
			else if (/^\d+$/.test(q.value.trim())) pickSearch(q.value.trim());
		} else if (e.key === "Escape") { q.value = ""; search.q = ""; renderSearch(); q.blur(); }
	});
	$("#sdrop").addEventListener("mousedown", e => { const r = e.target.closest(".sd-i"); if (r) { e.preventDefault(); pickSearch(r.dataset.id); } });

	$("#wl-head").addEventListener("click", e => {
		const b = e.target.closest(".wh");
		if (!b) return;
		const k = b.dataset.k;
		const s = S.wlSort;
		const first = k === "name" ? 1 : -1;
		if (s.key !== k) S.wlSort = { key: k, dir: first };
		else if (s.dir === first) S.wlSort = { key: k, dir: -first };
		else S.wlSort = { key: null, dir: -1 };
		store.set("wlSort", S.wlSort);
		S.wlCursor = -1;
		renderWatchlist();
	});
	$("#wl-list").addEventListener("click", e => {
		const r = e.target.closest(".wr");
		if (!r) return;
		S.wlCursor = Number(r.dataset.i);
		$("#wl-list").querySelectorAll(".wr.cur").forEach(x => x.classList.remove("cur"));
		r.classList.add("cur");
		selectItem(Number(r.dataset.id));
	});
	const wf = $("#wl-filter");
	wf.addEventListener("input", debounce(() => { S.wlFilter = wf.value; S.wlCursor = -1; renderWatchlist(); }, 80));
	wf.addEventListener("keydown", e => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveWlCursor(e.key === "ArrowDown" ? 1 : -1); }
		else if (e.key === "Enter" && wlView[Math.max(0, S.wlCursor)]) { selectItem(wlView[Math.max(0, S.wlCursor)].itemId); }
		else if (e.key === "Escape") { wf.value = ""; S.wlFilter = ""; renderWatchlist(); wf.blur(); }
	});
	$("#wl-cheap").addEventListener("click", () => { S.wlCheap = !S.wlCheap; $("#wl-cheap").classList.toggle("on", S.wlCheap); S.wlCursor = -1; renderWatchlist(); });

	$("#itool").addEventListener("click", e => {
		const b = e.target.closest("button");
		if (!b || b.disabled) return;
		if (b.dataset.range) setRange(b.dataset.range);
		else if (b.dataset.mode) { S.mode = b.dataset.mode; store.set("mode", S.mode); renderChart(); }
		else if (b.dataset.log) { S.log = b.dataset.log === "1"; store.set("log", S.log); renderChart(); }
		else if (b.dataset.ov) { S.ov[b.dataset.ov] = !S.ov[b.dataset.ov]; store.set("ov", S.ov); renderChart(); }
	});

	$("#tabbar").addEventListener("click", e => {
		const b = e.target.closest(".tb");
		if (b) return setTab(b.dataset.tab);
		if (e.target.closest("#bottom-size")) {
			const app = $("#app");
			const st = app.classList.contains("bottom-max") ? "min" : app.classList.contains("bottom-min") ? "norm" : "max";
			app.classList.remove("bottom-max", "bottom-min");
			if (st !== "norm") app.classList.add("bottom-" + st);
			store.set("bottom", st);
		}
	});
	const bs = store.get("bottom", "norm");
	if (bs !== "norm") $("#app").classList.add("bottom-" + bs);

	document.addEventListener("keydown", e => {
		const t = e.target;
		const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
		if (e.key === "/" && !typing) { e.preventDefault(); $("#q").focus(); $("#q").select(); return; }
		if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			moveWlCursor(e.key === "ArrowDown" ? 1 : -1);
		} else if (e.key === "Enter" && S.wlCursor >= 0 && wlView[S.wlCursor] && !(t.closest && t.closest("button,a"))) {
			selectItem(wlView[S.wlCursor].itemId);
		} else if (/^[1-4]$/.test(e.key)) {
			setRange(RANGES[Number(e.key) - 1][0]);
		} else if (e.key === "Escape") {
			$("#mkt").classList.remove("open");
		}
	});
}

function setRange(r) {
	if (S.range === r) return;
	S.range = r;
	store.set("range", r);
	S.week = r === "7d" ? null : S.week;
	if (S.sel) loadItem(false);
}

// ---------- Старт ----------

// Ссылка вида #item=2589&tab=craft&range=30d открывает нужный предмет и вкладку.
function readHash() {
	const p = new URLSearchParams(location.hash.replace(/^#/, ""));
	if (p.get("item")) S.sel = Number(p.get("item"));
	if (p.get("tab") && TABS.some(t => t.id === p.get("tab"))) currentTab = p.get("tab");
	if (p.get("range") && RANGES.some(r => r[0] === p.get("range"))) S.range = p.get("range");
}

async function start() {
	readHash();
	renderTabbar();
	bind();
	renderWatchlist();
	renderSide();
	await Promise.all([loadStatus(), loadMarkets()]);
	if (S.sel) selectItem(S.sel);
	await loadInstruments();
	setInterval(loadStatus, 60 * 1000);
	setInterval(loadInstruments, 5 * 60 * 1000);
	setInterval(() => { if (S.status) renderTop(); }, 30 * 1000);
}

start();
