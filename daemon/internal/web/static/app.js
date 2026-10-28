"use strict";

// Локальный интерфейс ForeverGold: без сборки, ванильный JS + uPlot.
const view = document.getElementById("view");
let charts = [];

const PRICE_KEY = /price|cost|value|median|min|buyout|margin|saving|profit|low|high|avg|average|net|spread/i;
const NOT_PRICE_KEY = /ratio|share|pct|percent|rate|count|qty|quantity|units|auctions|days|sales|level|id$|skill|discount|change|volatility|turnover|depth/i;

async function api(path, opts) {
	const r = await fetch(path, opts);
	if (!r.ok) throw new Error((await r.text()) || r.statusText);
	return r.json();
}

function el(tag, attrs = {}, ...children) {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
		else if (v !== undefined && v !== null) e.setAttribute(k, v);
	}
	for (const c of children.flat()) e.append(c instanceof Node ? c : document.createTextNode(c ?? ""));
	return e;
}

function gold(copper) {
	if (copper === null || copper === undefined || copper === "" || isNaN(copper)) return "—";
	const g = Number(copper) / 10000;
	if (Math.abs(g) >= 100) return g.toLocaleString("ru-RU", { maximumFractionDigits: 0 }) + "з";
	if (Math.abs(g) >= 1) return g.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "з";
	return (Number(copper) / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "с";
}

function num(v, digits = 0) {
	if (v === null || v === undefined || isNaN(v)) return "—";
	return Number(v).toLocaleString("ru-RU", { maximumFractionDigits: digits });
}

function ago(unix) {
	if (!unix) return "никогда";
	const s = Math.round(Date.now() / 1000 - unix);
	if (s < 90) return s + " с назад";
	if (s < 5400) return Math.round(s / 60) + " мин назад";
	if (s < 172800) return Math.round(s / 3600) + " ч назад";
	return Math.round(s / 86400) + " дн назад";
}

function panel(title, ...children) {
	return el("div", { class: "panel" }, title ? el("h2", {}, title) : "", ...children);
}

function clearCharts() {
	charts.forEach(c => c.destroy());
	charts = [];
}

function itemLink(id) {
	location.hash = "#/item/" + id;
}

// Таблица с сортировкой по клику на заголовок.
function table(columns, rows, onRow) {
	let sortKey = null, dir = -1;
	const tbody = el("tbody");
	const render = () => {
		const sorted = sortKey === null ? rows : [...rows].sort((a, b) => {
			const x = a[sortKey], y = b[sortKey];
			if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
			return String(x ?? "").localeCompare(String(y ?? ""), "ru") * dir;
		});
		tbody.replaceChildren(...sorted.map(r => {
			const tr = el("tr", onRow ? { class: "link", onclick: () => onRow(r) } : {},
				columns.map(c => el("td", { class: c.num ? "num" : "" }, c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? ""))));
			return tr;
		}));
	};
	const head = el("tr", {}, columns.map(c => el("th", {
		class: c.num ? "num" : "",
		onclick: () => { dir = sortKey === c.key ? -dir : -1; sortKey = c.key; render(); },
	}, c.title)));
	render();
	return el("table", {}, el("thead", {}, head), tbody);
}

// ---------- Обзор ----------

async function showOverview() {
	const [status, movers, deals] = await Promise.all([api("/api/status"), api("/api/movers"), api("/api/doc/deals").catch(() => null)]);
	const jobs = Object.entries(status.jobs).map(([name, j]) => ({
		name, ok: j.lastOk ? ago(Date.parse(j.lastOk) / 1000) : "никогда", note: j.note || "", error: j.error || "",
	}));
	const c = status.counts || {};
	view.replaceChildren(
		marketClosed(deals) ? panel("Рынок ещё не открыт",
			el("p", {}, `AHledger пишет, что ${deals.marketLabel || status.market} ещё не открыт, поэтому цен, графиков и прогнозов пока нет. Демон уже работает и начнёт копить историю сам, как только появятся первые сканы.`),
			el("p", { class: "muted" }, "Свои сканы аддоном попадают сюда сразу: стакан предмета на его странице появится после полного скана на аукционе и /reload.")) : "",
		panel("Состояние",
			el("div", { class: "grid" },
				stat("Рынок", status.market, "small"),
				stat("Предметов в таблице", num(c.latest)),
				stat("Точек истории", num(c.snapshots)),
				stat("Строк своих сканов", num(c.own_scans)),
				stat("Названий из игры", num(c.items)),
			),
			el("p", { class: "muted" }, status.wowPath ? "Игра: " + status.wowPath : "Папка игры не найдена: укажите wowPath в config.json рядом с exe."),
			table([
				{ key: "name", title: "Задача" },
				{ key: "ok", title: "Успешно" },
				{ key: "note", title: "Итог" },
				{ key: "error", title: "Ошибка", fmt: v => el("span", { class: "err" }, v) },
			], jobs)),
		panel("Отклонения от медианы за 7 дней (ликвидные)",
			movers.length ? table(itemColumns(), movers.map(enrich), r => itemLink(r.itemId))
				: el("p", { class: "muted" }, "Пока нет данных. Нажмите «Синк сейчас» или подождите до 15 минут.")),
	);
}

function stat(k, v, cls) {
	return el("div", { class: "stat" }, el("div", { class: "v " + (cls || "") }, v), el("div", { class: "k" }, k));
}

function enrich(r) {
	return { ...r, name: r.name || "item:" + r.itemId, sales: r.sales10 / 10, dev: r.median7 ? r.min / r.median7 - 1 : null };
}

function itemColumns() {
	return [
		{ key: "name", title: "Предмет" },
		{ key: "min", title: "Мин", num: true, fmt: gold },
		{ key: "median7", title: "Медиана 7д", num: true, fmt: gold },
		{ key: "dev", title: "Откл.", num: true, fmt: v => v === null ? "—" : el("span", { class: v < 0 ? "good" : "bad" }, (v * 100).toFixed(0) + "%") },
		{ key: "qty", title: "На аукционе", num: true, fmt: v => num(v) },
		{ key: "sales", title: "Продаж/день", num: true, fmt: v => num(v, 1) },
	];
}

// ---------- Предмет ----------

let itemRange = "7d";

async function showItem(id) {
	const input = el("input", { type: "search", placeholder: "Название или номер предмета", style: "min-width:260px" });
	const results = el("div");
	let timer;
	input.addEventListener("input", () => {
		clearTimeout(timer);
		timer = setTimeout(async () => {
			const list = await api("/api/search?q=" + encodeURIComponent(input.value));
			results.replaceChildren(list.length ? table(itemColumns(), list.map(enrich), r => itemLink(r.itemId)) : el("p", { class: "muted" }, "Ничего не найдено"));
		}, 250);
	});
	const searchPanel = panel("Поиск", input, results);
	if (!id) {
		view.replaceChildren(searchPanel);
		input.dispatchEvent(new Event("input"));
		input.focus();
		return;
	}

	const data = await api(`/api/item/${id}?range=${itemRange}`);
	const l = data.latest;
	const title = (l && l.name) || "item:" + id;
	const ranges = el("div", { class: "toolbar" }, ["1d", "7d", "30d", "90d"].map(r =>
		el("button", { class: r === itemRange ? "on" : "", onclick: () => { itemRange = r; showItem(id); } },
			{ "1d": "День", "7d": "7 дней", "30d": "Месяц", "90d": "3 месяца" }[r])));

	const stats = l ? el("div", { class: "grid" },
		stat("Минимум сейчас", gold(l.min)),
		stat("Медиана сейчас", gold(l.median)),
		stat("Медиана 7д", gold(l.median7)),
		stat("Медиана 30д", gold(l.median30)),
		stat("Коридор 30д", gold(l.low30) + " – " + gold(l.high30)),
		stat("Продаж в день", num(l.sales10 / 10, 1)),
		stat("На аукционе", num(l.qty)),
		stat("Снимок AHledger", ago(l.t)),
	) : el("p", { class: "muted" }, "AHledger пока ничего не знает об этом предмете.");

	const priceBox = el("div", { class: "chart" });
	const qtyBox = el("div", { class: "chart" });
	const forecastBox = el("div");
	view.replaceChildren(
		searchPanel,
		panel(title + " (" + id + ")", stats),
		panel("Цена", ranges, priceBox, el("div", { class: "legend-note" }, "Минимум и медиана по снимкам AHledger, красные точки: минимум в ваших сканах.")),
		panel("Прогноз минимальной цены на 7 дней", forecastBox),
		panel("Количество на аукционе", qtyBox),
		panel("Стакан последнего скана" + (data.bookTime ? " (" + ago(data.bookTime) + ")" : ""), bookView(data.book)),
	);
	clearCharts();
	drawPrice(priceBox, data);
	drawQty(qtyBox, data);
	const [fc, recent] = await Promise.all([api(`/api/item/${id}/forecast`), api(`/api/item/${id}?range=7d`)]);
	forecastView(forecastBox, fc, recent.series || [], l);
}

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

function pct(v, digits = 1) {
	const sign = v > 0 ? "+" : "";
	return sign + (v * 100).toFixed(digits) + "%";
}

function slotText(s) {
	return WEEKDAYS[s.weekday] + " " + String(s.hour).padStart(2, "0") + ":00";
}

// Полоса из ячеек: цвет и подпись показывают, насколько цена в этот час/день выше или ниже обычной.
function profileStrip(labels, factors) {
	const cells = factors.map((f, i) => {
		const d = f - 1;
		const alpha = Math.min(Math.abs(d) / 0.15, 1) * 0.55;
		const color = d < 0 ? `rgba(46,125,50,${alpha})` : `rgba(198,40,40,${alpha})`;
		return el("div", { class: "cell", style: `background:${color}`, title: labels[i] + ": " + pct(d) },
			el("div", { class: "lbl" }, labels[i]), el("div", { class: "val" }, pct(d, 0)));
	});
	return el("div", { class: "strip", style: `grid-template-columns:repeat(${factors.length},1fr)` }, cells);
}

function forecastView(box, fc, recent, latest) {
	if (!fc.ok) {
		box.replaceChildren(el("p", { class: "muted" }, (fc.note || "Прогноз пока недоступен") + ". История копится с момента запуска демона: каждые 15 минут по снимку."));
		return;
	}
	const chartBox = el("div", { class: "chart" });
	const nowPrice = latest && latest.min;
	const best = fc.points.reduce((a, p) => (p.mid > a.mid ? p : a), fc.points[0]);
	const worst = fc.points.reduce((a, p) => (p.mid < a.mid ? p : a), fc.points[0]);
	box.replaceChildren(
		el("div", { class: "grid" },
			stat("Тренд", pct(fc.trendPerDay) + " в день", fc.trendPerDay >= 0 ? "good" : "bad"),
			stat("Разброс", "±" + (fc.volatility * 100).toFixed(1) + "%"),
			stat("Обычно дешевле всего", slotText(fc.cheapestSlot)),
			stat("Обычно дороже всего", slotText(fc.dearestSlot)),
			stat("Минимум прогноза", gold(worst.mid) + ", " + fmtTime(worst.t)),
			stat("Максимум прогноза", gold(best.mid) + ", " + fmtTime(best.t)),
		),
		chartBox,
		el("div", { class: "legend-note" }, "Серая полоса: 80% вилка прогноза минимальной цены. Прогноз строится по истории за " + fc.days.toFixed(0) +
			" дн.: тренд за 7 дней (затухает за пару дней), профиль по часам и дням недели. Это статистика, а не гарантия: разовые события (патчи, открытие рейдов) она не видит."),
		el("h3", {}, "Цена по часам суток (отклонение от обычной)"),
		profileStrip([...Array(24).keys()].map(h => String(h).padStart(2, "0")), fc.hourly),
		el("h3", {}, "По дням недели"),
		profileStrip([1, 2, 3, 4, 5, 6, 0].map(d => WEEKDAYS[d]), [1, 2, 3, 4, 5, 6, 0].map(d => fc.weekday[d])),
	);
	if (nowPrice && best.mid * 0.95 > nowPrice) {
		box.prepend(el("p", { class: "good" }, `Купив сейчас по ${gold(nowPrice)} и продав около ${fmtTime(best.t)}, по прогнозу получите ${pct(best.mid * 0.95 / nowPrice - 1, 0)} после комиссии.`));
	}

	const times = [...recent.map(p => p.t), ...fc.points.map(p => p.t)];
	const hist = [...recent.map(p => p.min / 10000), ...fc.points.map(() => null)];
	const pad = recent.map(() => null);
	const mid = [...pad, ...fc.points.map(p => p.mid / 10000)];
	const low = [...pad, ...fc.points.map(p => p.low / 10000)];
	const high = [...pad, ...fc.points.map(p => p.high / 10000)];
	const money = (u, v) => v == null ? "—" : gold(v * 10000);
	const u = new uPlot({
		width: chartWidth(chartBox), height: 260,
		axes: axes("цена", true),
		series: [
			timeSeries,
			{ label: "Минимум", stroke: css("--series-min"), width: 2, spanGaps: true, value: money },
			{ label: "Прогноз", stroke: css("--series-median"), width: 2, dash: [6, 4], value: money },
			{ label: "Нижняя граница", stroke: "transparent", value: money },
			{ label: "Верхняя граница", stroke: "transparent", value: money },
		],
		bands: [{ series: [4, 3], fill: "rgba(128,128,128,0.18)" }],
	}, [times, hist, mid, low, high], chartBox);
	charts.push(u);
}

// ---------- Прогнозы ----------

async function showForecasts() {
	const list = await api("/api/opportunities");
	const rows = list.map(o => ({ ...enrich(o), sellMid: o.sellMid, sellAt: o.sellAt, gain: o.gain, trend: o.trendPerDay, vol: o.volatility, cheapest: slotText(o.cheapest) }));
	view.replaceChildren(panel("Подешевле сейчас, дороже по прогнозу на 3 дня",
		el("p", { class: "muted" }, "Ликвидные предметы, где прогноз минимальной цены в ближайшие 3 дня после комиссии 5% выше текущего минимума хотя бы на 10%. Чем больше разброс, тем меньше доверия: доходность меньше разброса это почти шум."),
		rows.length ? table([
			{ key: "name", title: "Предмет" },
			{ key: "min", title: "Мин сейчас", num: true, fmt: gold },
			{ key: "sellMid", title: "Прогноз", num: true, fmt: gold },
			{ key: "sellAt", title: "Когда", fmt: v => fmtTime(v) },
			{ key: "gain", title: "Доходность", num: true, fmt: v => el("span", { class: "good" }, pct(v, 0)) },
			{ key: "trend", title: "Тренд/день", num: true, fmt: v => pct(v) },
			{ key: "vol", title: "Разброс", num: true, fmt: v => "±" + (v * 100).toFixed(0) + "%" },
			{ key: "cheapest", title: "Дешевле всего обычно" },
			{ key: "sales", title: "Продаж/день", num: true, fmt: v => num(v, 1) },
		], rows, r => itemLink(r.itemId)) : el("p", { class: "muted" }, "Пока ничего: для прогноза нужно хотя бы 3 дня истории.")));
}

function css(name) {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Склеивает две серии с разными временами в одну ось x для uPlot.
function mergeSeries(series, own) {
	const times = [...new Set([...series.map(p => p.t), ...own.map(p => p.t)])].sort((a, b) => a - b);
	const byT = new Map(series.map(p => [p.t, p]));
	const ownByT = new Map(own.map(p => [p.t, p]));
	return {
		times,
		min: times.map(t => byT.has(t) ? byT.get(t).min / 10000 : null),
		median: times.map(t => byT.has(t) ? byT.get(t).median / 10000 : null),
		qty: times.map(t => byT.has(t) ? byT.get(t).qty : null),
		ownMin: times.map(t => ownByT.has(t) ? ownByT.get(t).min / 10000 : null),
		ownQty: times.map(t => ownByT.has(t) ? ownByT.get(t).qty : null),
	};
}

function fmtTime(unix, withTime = true) {
	const opts = { day: "2-digit", month: "2-digit" };
	if (withTime) Object.assign(opts, { hour: "2-digit", minute: "2-digit" });
	return new Date(unix * 1000).toLocaleString("ru-RU", opts);
}

// Ось X: даты по-русски, время только когда шаг меньше суток. Ось Y: золото или штуки.
function axes(yLabel, money) {
	const stroke = css("--muted"), grid = { stroke: css("--line"), width: 1 };
	return [
		{ stroke, grid, values: (u, vals, space, incr) => vals.map(v => fmtTime(v, incr < 86400)) },
		{ stroke, grid, label: yLabel, size: 70, values: (u, vals) => vals.map(v => money ? gold(v * 10000) : num(v)) },
	];
}

const timeSeries = { label: "Время", value: (u, v) => v == null ? "—" : fmtTime(v) };

function chartWidth(box) {
	return Math.max(300, box.clientWidth || view.clientWidth - 40);
}

function drawPrice(box, data) {
	const m = mergeSeries(data.series || [], data.own || []);
	if (!m.times.length) { box.append(el("p", { class: "muted" }, "Нет истории за этот период.")); return; }
	const u = new uPlot({
		width: chartWidth(box), height: 300,
		axes: axes("цена", true),
		series: [
			timeSeries,
			{ label: "Минимум", stroke: css("--series-min"), width: 2, spanGaps: true, value: (u, v) => v == null ? "—" : gold(v * 10000) },
			{ label: "Медиана", stroke: css("--series-median"), width: 2, spanGaps: true, value: (u, v) => v == null ? "—" : gold(v * 10000) },
			{ label: "Мой скан", stroke: css("--series-own"), width: 0, points: { show: true, size: 6, fill: css("--series-own") }, value: (u, v) => v == null ? "—" : gold(v * 10000) },
		],
	}, [m.times, m.min, m.median, m.ownMin], box);
	charts.push(u);
}

function drawQty(box, data) {
	const m = mergeSeries(data.series || [], data.own || []);
	if (!m.times.length) return;
	const u = new uPlot({
		width: chartWidth(box), height: 160,
		axes: axes("штук", false),
		series: [
			timeSeries,
			{ label: "AHledger", stroke: css("--series-qty"), width: 2, spanGaps: true },
			{ label: "Мой скан", stroke: css("--series-own"), width: 0, points: { show: true, size: 6, fill: css("--series-own") } },
		],
	}, [m.times, m.qty, m.ownQty], box);
	charts.push(u);
}

function bookView(book) {
	if (!book || !book.length) return el("p", { class: "muted" }, "Своих сканов с этим предметом ещё нет. Сделайте полный скан в аддоне и /reload, демон заберёт стакан.");
	let cum = 0;
	const rows = book.map(b => ({ ...b, cum: (cum += b.qty), cost: 0 }));
	let spent = 0;
	rows.forEach(r => { spent += r.price * r.qty; r.cost = spent; });
	const maxQty = Math.max(...rows.map(r => r.qty));
	return el("table", { class: "book" },
		el("thead", {}, el("tr", {}, el("th", { class: "num" }, "Цена"), el("th", { class: "num" }, "Штук"), el("th", {}, ""), el("th", { class: "num" }, "Всего"), el("th", { class: "num" }, "Выкупить до уровня"))),
		el("tbody", {}, rows.map(r => el("tr", {},
			el("td", { class: "num" }, gold(r.price)),
			el("td", { class: "num" }, num(r.qty)),
			el("td", { class: "bar" }, el("div", { class: "fill", style: `width:${(r.qty / maxQty * 100).toFixed(1)}%` })),
			el("td", { class: "num" }, num(r.cum)),
			el("td", { class: "num" }, gold(r.cost)),
		))));
}

// ---------- Документы AHledger ----------

// Ищет в ответе первый массив объектов: формат части эндпоинтов не документирован, показываем как есть.
function findRows(doc) {
	if (Array.isArray(doc)) return doc;
	let best = null;
	for (const v of Object.values(doc || {})) {
		if (Array.isArray(v) && v.length && typeof v[0] === "object") {
			if (!best || v.length > best.length) best = v;
		}
	}
	return best || [];
}

function flatten(obj, prefix = "", out = {}) {
	for (const [k, v] of Object.entries(obj)) {
		const key = prefix ? prefix + "." + k : k;
		if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
		else if (Array.isArray(v)) out[key] = v.length && typeof v[0] === "object" ? v.map(x => x.name || x.id).join(", ") : v.join(", ");
		else out[key] = v;
	}
	return out;
}

// Подписи известных полей AHledger; неизвестные показываются как есть.
const COL_TITLES = {
	"recipe.name": "Рецепт", "recipe.skillRequired": "Скилл", "recipe.acquisition": "Где взять", "recipe.profession": "Профессия",
	"result.name": "Результат", "result.id": "ID", "resultPrice": "Цена результата", "netValue": "После комиссии",
	"cost": "Себестоимость", "margin": "Маржа", "marginRatio": "Маржа, x", "resultSalesPerDay": "Продаж/день",
	"profitPerDay": "Прибыль/день", "reagents": "Реагенты", "unpriced": "Без цены",
	"item.name": "Предмет", "item.id": "ID", "minBuyout": "Мин", "median30d": "Медиана 30д", "median7d": "Медиана 7д",
	"saving": "Экономия", "salesPerDay": "Продаж/день", "discount": "Скидка", "quantity": "Штук",
};

const SKIP_COLS = /url$|chartUrl|icon|attribution|quality$/i;

function autoColumns(rows) {
	const keys = [];
	for (const r of rows.slice(0, 20)) for (const k of Object.keys(r)) if (!keys.includes(k) && !SKIP_COLS.test(k)) keys.push(k);
	return keys.slice(0, 14).map(k => {
		const sample = rows.find(r => r[k] !== null && r[k] !== undefined)?.[k];
		const isNum = typeof sample === "number";
		const leaf = k.split(".").pop();
		const money = isNum && PRICE_KEY.test(leaf) && !NOT_PRICE_KEY.test(leaf);
		return { key: k, title: COL_TITLES[k] || k, num: isNum, fmt: money ? gold : isNum ? v => num(v, 2) : undefined };
	});
}

function rowItemId(r) {
	for (const k of ["itemId", "item.id", "result.id", "id"]) if (typeof r[k] === "number") return r[k];
	return null;
}

const DOC_TITLES = {
	deals: "Сделки AHledger: лоты дешевле своей медианы за 30 дней",
	signals: "Сигналы: покупка ниже средней за 30 дней и как часто цена восстанавливалась",
	structure: "Структура рынка: глубина, спред, оборот, волатильность, паттерны по дням недели",
};

async function showDoc(kind, title) {
	let doc, fetched;
	try {
		const r = await fetch("/api/doc/" + kind);
		if (!r.ok) throw new Error(await r.text());
		fetched = Number(r.headers.get("X-Fetched-At"));
		doc = await r.json();
	} catch (e) {
		view.replaceChildren(panel(title || DOC_TITLES[kind] || kind, el("p", { class: "err" }, String(e.message || e))));
		return;
	}
	const rows = findRows(doc).map(r => flatten(r));
	const meta = el("p", { class: "muted" }, "Скачано " + ago(fetched) + (doc.pricesAsOf ? ", цены на " + new Date(doc.pricesAsOf).toLocaleString("ru-RU") : ""));
	const notes = Array.isArray(doc.notes) ? el("ul", { class: "muted" }, doc.notes.map(n => el("li", {}, n))) : "";
	const body = rows.length
		? table(autoColumns(rows), rows, r => { const id = rowItemId(r); if (id) itemLink(id); })
		: emptyDoc(doc);
	view.replaceChildren(panel(title || DOC_TITLES[kind] || kind, meta, notes, body));
}

// Пустой ответ AHledger: объясняем причину словами, сырой JSON прячем под спойлер.
function emptyDoc(doc) {
	const closed = marketClosed(doc);
	const text = closed
		? `Рынок ${doc.marketLabel || doc.market} ещё не открыт, поэтому у AHledger по нему пока нет цен. Данные появятся сами после открытия серверов.`
		: "AHledger пока ничего не нашёл по этому запросу." + (doc && doc.message ? " Ответ сервиса: " + doc.message : "");
	return el("div", {},
		el("p", {}, text),
		doc && doc.page ? el("p", {}, el("a", { href: doc.page, target: "_blank", rel: "noopener" }, "Открыть на AHledger")) : "",
		el("details", { class: "muted" }, el("summary", {}, "Ответ сервиса целиком"),
			el("pre", { class: "raw" }, JSON.stringify(doc, null, 2).slice(0, 20000))));
}

function marketClosed(doc) {
	return !!(doc && typeof doc.marketStatus === "string" && /not open/i.test(doc.marketStatus));
}

async function showCrafting(prof) {
	const status = await api("/api/status");
	const profs = status.professions || [];
	prof = prof || profs[0];
	const bar = el("div", { class: "toolbar" }, profs.map(p =>
		el("button", { class: p === prof ? "on" : "", onclick: () => { location.hash = "#/crafting/" + p; } }, p)));
	await showDoc("crafting-" + prof, "Крафт: " + prof + " (маржа после комиссии аукциона)");
	view.prepend(bar);
}

// ---------- Роутинг ----------

async function route() {
	clearCharts();
	const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
	const tab = parts[0] === "doc" ? parts[1] : parts[0] || "overview";
	document.querySelectorAll("#tabs a").forEach(a => a.classList.toggle("active", a.dataset.tab === tab));
	view.replaceChildren(el("p", { class: "muted" }, "Загрузка…"));
	try {
		if (!parts.length) await showOverview();
		else if (parts[0] === "item") await showItem(parts[1]);
		else if (parts[0] === "doc") await showDoc(parts[1]);
		else if (parts[0] === "crafting") await showCrafting(parts[1]);
		else if (parts[0] === "forecasts") await showForecasts();
		else await showOverview();
	} catch (e) {
		view.replaceChildren(panel("Ошибка", el("p", { class: "err" }, String(e.message || e))));
	}
}

document.getElementById("sync").addEventListener("click", async () => {
	await api("/api/sync", { method: "POST" });
	setTimeout(route, 3000);
});

api("/api/status").then(s => { document.getElementById("market").textContent = s.market; }).catch(() => {});
window.addEventListener("hashchange", route);
window.addEventListener("resize", () => { clearTimeout(window._rz); window._rz = setTimeout(route, 300); });
route();
