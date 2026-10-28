"use strict";
// Нижние вкладки: скринеры (флипы, крафт, сигналы, распыление), обзор рынка, прогнозы, калькулятор.

const TS = {
	flips: { sort: { k: "ev", dir: -1 }, minDisc: 0.05, knives: false, salesOnly: false },
	craft: { sort: { k: "ppd", dir: -1 }, prof: null, priced: true, q: "", open: new Set() },
	signals: { sort: { k: "firing", dir: -1 }, now: false, tested: false },
	de: { sort: { k: "profit", dir: -1 } },
	fc: { sort: { k: "gain", dir: -1 } },
	calc: { id: null, B: "", q: "20", P: "", dur: 24, dep: "" },
};

const PROF_RU = {
	alchemy: "Алхимия", blacksmithing: "Кузнечное дело", cooking: "Кулинария", enchanting: "Наложение чар", engineering: "Инженерное дело",
	"first aid": "Первая помощь", firstaid: "Первая помощь", herbalism: "Травничество", leatherworking: "Кожевничество", mining: "Горное дело",
	skinning: "Снятие шкур", tailoring: "Портняжное дело", jewelcrafting: "Ювелирное дело", inscription: "Начертание",
};

// ---------- Таблица ----------

// cols: {k, t, num, get(r), fmt(r), cls, title, w}
function dataTable(box, cfg) {
	const st = cfg.state;
	const col = cfg.cols.find(c => c.k === st.sort.k);
	let rows = cfg.rows;
	if (col) {
		const g = col.get || (r => r[col.k]);
		rows = [...rows].sort((a, b) => {
			const x = g(a), y = g(b);
			const xn = x === null || x === undefined || (typeof x === "number" && !isFinite(x));
			const yn = y === null || y === undefined || (typeof y === "number" && !isFinite(y));
			if (xn && yn) return 0;
			if (xn) return 1;
			if (yn) return -1;
			if (typeof x === "string") return x.localeCompare(y, "ru") * st.sort.dir;
			return (x - y) * st.sort.dir;
		});
	}
	const head = cfg.cols.map(c => {
		const on = st.sort.k === c.k;
		return `<th class="${c.num ? "num" : ""}${c.sortable === false ? "" : " s"}${on ? " on" : ""}" data-k="${c.k}"${c.w ? ` style="width:${c.w}"` : ""}${c.title ? ` title="${esc(c.title)}"` : ""}>${c.t}${on ? `<span class="ar">${st.sort.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`;
	}).join("");
	const body = rows.map((r, i) => {
		const id = cfg.rowId ? cfg.rowId(r) : null;
		const ex = cfg.expanded && cfg.expanded(r);
		const tr = `<tr class="${id ? "lk" : ""}${cfg.rowCls ? " " + cfg.rowCls(r) : ""}${ex ? " ex" : ""}" data-i="${i}">${cfg.cols.map(c => `<td class="${c.num ? "num" : ""}${c.cls ? " " + c.cls : ""}">${c.fmt ? c.fmt(r) : esc(r[c.k] ?? "")}</td>`).join("")}</tr>`;
		return ex ? tr + `<tr class="sub"><td colspan="${cfg.cols.length}">${cfg.expandHTML(r)}</td></tr>` : tr;
	}).join("");
	box.innerHTML = `<div class="tw"><table class="dt"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
	const tw = box.querySelector(".tw");
	tw.querySelector("thead").addEventListener("click", e => {
		const th = e.target.closest("th.s");
		if (!th) return;
		const k = th.dataset.k;
		st.sort = st.sort.k === k ? { k, dir: -st.sort.dir } : { k, dir: cfg.cols.find(c => c.k === k).num ? -1 : 1 };
		const sc = tw.scrollTop;
		dataTable(box, cfg);
		box.querySelector(".tw").scrollTop = sc;
	});
	tw.querySelector("tbody").addEventListener("click", e => {
		if (e.target.closest("a")) return;
		const tr = e.target.closest("tr[data-i]");
		if (!tr) return;
		const r = rows[+tr.dataset.i];
		if (cfg.onToggle && e.target.closest(".xp")) { cfg.onToggle(r); const sc = tw.scrollTop; dataTable(box, cfg); box.querySelector(".tw").scrollTop = sc; return; }
		tw.querySelectorAll("tr.act").forEach(x => x.classList.remove("act"));
		tr.classList.add("act");
		const id = cfg.rowId && cfg.rowId(r);
		if (id) openItem(id);
	});
}

// Шапка вкладки: инструменты слева, мета справа.
function tabFrame(body, toolsHTML, note) {
	body.innerHTML = `<div class="tf"><div class="tf-bar">${toolsHTML || ""}${note ? `<span class="tf-note">${note}</span>` : ""}</div><div class="tf-body"></div></div>`;
	return body.querySelector(".tf-body");
}

function setMeta(html) {
	const m = $("#tab-meta");
	if (m) m.innerHTML = html || "";
}

function docMeta(r, extra) {
	const asOf = r.doc && r.doc.pricesAsOf ? toSec(r.doc.pricesAsOf) : 0;
	setMeta(`${extra ? extra + '<span class="sep">·</span>' : ""}AHledger${asOf ? ` · цены ${ago(asOf)}` : ""}${r.fetched ? ` · загружено ${ago(r.fetched)}` : ""}`);
}

function itemCell(o, extra = "") {
	return `<div class="ic">${iconHTML(o, 20)}${nameHTML(o)}${extra}</div>`;
}

// Документ AHledger → объект предмета для отображения (ruName, качество, иконка из вотчлиста).
function docItem(it) {
	if (!it) return {};
	const inst = S.byId.get(it.id);
	return { ...it, itemId: it.id, ruName: it.ruName || (inst && inst.name !== inst.nameEn ? inst.name : undefined), icon: it.icon || (inst && inst.icon), quality: it.quality || (inst && inst.quality) };
}

function loadingInto(box, cols = 6) {
	box.innerHTML = skeletonRows(8, cols);
}

function docError(box, e, what) {
	box.innerHTML = e && e.status === 404
		? stateHTML("wait", what + " пока нет", "Демон ещё не скачал этот отчёт AHledger. Он обновляется раз в несколько минут.")
		: stateHTML("error", "Не удалось загрузить " + what.toLowerCase(), esc((e && e.message) || ""));
}

function closedOr(box, doc, emptyTitle, emptyText) {
	if (marketClosed(doc)) { box.innerHTML = stateHTML("closed", "Рынок ещё не открыт", "У AHledger по этому рынку пока нет цен."); return true; }
	box.innerHTML = stateHTML("empty", emptyTitle, emptyText);
	return true;
}

const segHTML = (name, opts, cur) => `<div class="seg sm" data-seg="${name}">${opts.map(([v, l]) => `<button class="${String(v) === String(cur) ? "on" : ""}" data-v="${v}">${l}</button>`).join("")}</div>`;
const toggleHTML = (name, label, on, title) => `<button class="tgl${on ? " on" : ""}" data-tgl="${name}" title="${esc(title || "")}"><span class="tgl-b"></span>${label}</button>`;

function bindBar(body, onSeg, onTgl) {
	body.querySelector(".tf-bar").addEventListener("click", e => {
		const sb = e.target.closest("[data-seg] button");
		if (sb) return onSeg && onSeg(sb.parentElement.dataset.seg, sb.dataset.v);
		const tb = e.target.closest("[data-tgl]");
		if (tb) return onTgl && onTgl(tb.dataset.tgl);
	});
}

// ---------- Флипы ----------

function flipRows(dealsDoc) {
	const st = TS.flips;
	const map = new Map();
	const calc = (o) => {
		const targets = [o.m30, o.m7].filter(v => isNum(v) && v > 0);
		o.target = targets.length ? Math.min(...targets) : null;
		o.net = isNum(o.target) && isNum(o.buy) ? o.target * CUT - o.buy : null;
		o.roi = isNum(o.net) && o.buy > 0 ? o.net / o.buy : null;
		if (isNum(o.S) && o.S > 0 && isNum(o.net)) {
			o.qs = Math.min(isNum(o.qty) ? o.qty : o.S * 3, o.S * 3);
			o.T = o.qs / o.S;
			o.ev = o.net * o.qs / Math.max(o.T, 1);
		} else { o.qs = null; o.T = null; o.ev = null; }
		return o;
	};
	for (const x of S.instruments) {
		const ind = x.ind || {};
		if (!isNum(ind.discount) || ind.discount < st.minDisc) continue;
		map.set(x.itemId, calc({ id: x.itemId, meta: x, buy: x.min, m30: x.median30, m7: x.median7, disc: ind.discount, S: x.salesPerDay, qty: x.qty, dos: ind.dos, mom: ind.momentum, z: ind.z, src: "демон" }));
	}
	for (const d of (dealsDoc && dealsDoc.deals) || []) {
		const it = docItem(d.item);
		const id = it.id;
		if (!id) continue;
		const ex = map.get(id);
		if (ex) { ex.src = "AHledger + демон"; ex.dealQty = d.quantity; continue; }
		const inst = S.byId.get(id);
		const disc = isNum(d.discount) ? d.discount : null;
		if (isNum(disc) && disc < st.minDisc) continue;
		map.set(id, calc({
			id, meta: inst || it, buy: d.minBuyout ?? d.price ?? d.min, m30: d.median30d ?? d.median30, m7: d.median7d ?? d.median7, disc,
			S: d.salesPerDay, qty: d.quantity, dealQty: d.quantity, dos: inst && inst.ind ? inst.ind.dos : null, mom: inst && inst.ind ? inst.ind.momentum : null, src: "AHledger",
		}));
	}
	let rows = [...map.values()].filter(r => isNum(r.net));
	const knives = rows.filter(r => isNum(r.mom) && r.mom < -0.1).length;
	if (!st.knives) rows = rows.filter(r => !(isNum(r.mom) && r.mom < -0.1));
	if (st.salesOnly) rows = rows.filter(r => isNum(r.S) && r.S > 0);
	return { rows, knives };
}

function renderFlips(body) {
	const st = TS.flips;
	const tools = segHTML("disc", [[0.05, "≥5%"], [0.15, "≥15%"], [0.25, "≥25%"], [0.35, "≥35%"]], st.minDisc) +
		toggleHTML("knives", "Падающие ножи", st.knives, "Моментум < −10%: цена ниже медианы, но неделя падает") +
		toggleHTML("sales", "Только с продажами", st.salesOnly, "Скрыть предметы без оценки продаж в день");
	const box = tabFrame(body, tools, "net/шт = цель × 0,95 − покупка · цель = min(медиана 30д, 7д) · EV/день = net × продаваемое / T");
	bindBar(body, (seg, v) => { st.minDisc = Number(v); renderFlips(body); }, (t) => { if (t === "knives") st.knives = !st.knives; else st.salesOnly = !st.salesOnly; renderFlips(body); });
	loadingInto(box, 9);
	getDoc("deals").then(r => draw(r)).catch(() => draw(null));
	function draw(r) {
		if (currentTab !== "flips") return;
		const { rows, knives } = flipRows(r && r.doc);
		if (r) docMeta(r, `${rows.length} ${plural(rows.length, "идея", "идеи", "идей")}${knives && !st.knives ? ` · скрыто ножей: ${knives}` : ""}`);
		if (!rows.length) {
			if (r && marketClosed(r.doc)) return closedOr(box, r.doc);
			box.innerHTML = stateHTML("empty", "Флипов нет", S.instruments.length ? `Ни один ликвидный предмет не торгуется на ${Math.round(st.minDisc * 100)}%+ ниже медианы с прибылью после 5% комиссии.${knives && !st.knives ? " Есть скрытые падающие ножи." : ""}` : "Вотчлист ещё пуст.");
			return;
		}
		const stale = isStale();
		dataTable(box, {
			state: st,
			rows,
			rowId: r => r.id,
			rowCls: r => (isNum(r.mom) && r.mom < -0.1 ? "knife" : ""),
			cols: [
				{ k: "name", t: "Предмет", get: r => itemName(r.meta), fmt: r => itemCell(r.meta, isNum(r.mom) && r.mom < -0.1 ? '<span class="tag dear" title="Падающий нож: моментум < −10%">нож</span>' : "") },
				{ k: "buy", t: "Покупка", num: true, fmt: r => money(r.buy) },
				{ k: "target", t: "Цель", num: true, fmt: r => money(r.target), title: "min(медиана 30д, медиана 7д)" },
				{ k: "disc", t: "Скидка", num: true, fmt: r => `<span class="${stale ? "" : discCls(r.disc)}">${pct(r.disc, 0, false)}</span>`, title: "1 − покупка / медиана 30д" },
				{ k: "net", t: "Net/шт", num: true, fmt: r => `<span class="${r.net > 0 ? "pos" : "neg"}">${money(r.net)}</span>`, title: "цель × 0,95 − покупка" },
				{ k: "roi", t: "ROI", num: true, fmt: r => `<span class="${r.roi > 0 ? "pos" : "neg"}">${pct(r.roi, 0)}</span>` },
				{ k: "S", t: "Прод/день", num: true, fmt: r => (isNum(r.S) && r.S > 0 ? num(r.S, 1) : '<span class="na" title="нет оценки продаж">—</span>') },
				{ k: "dos", t: "DoS", num: true, fmt: r => `<span class="${dosCls(r.dos)}">${fmtDos(r.dos)}</span>`, title: "Дней запаса" },
				{ k: "mom", t: "Моментум", num: true, fmt: r => `<span class="${isNum(r.mom) && Math.abs(r.mom) > 0.1 ? signCls(r.mom) : ""}">${pct(r.mom, 0)}</span>` },
				{ k: "ev", t: "EV/день", num: true, fmt: r => (isNum(r.ev) ? `<b class="${r.ev > 0 ? "pos" : "neg"}">${money(r.ev, { compact: true })}</b>` : '<span class="na" title="нужна оценка продаж в день">—</span>'), title: "net × min(кол-во, S·3) / T_продажи" },
				{ k: "src", t: "Источник", fmt: r => `<span class="src">${r.src}</span>` },
			],
		});
	}
}

// ---------- Крафт ----------

function renderCraft(body) {
	const st = TS.craft;
	const profs = (S.status && S.status.professions) || [];
	if (!profs.length) {
		tabFrame(body, "", "").innerHTML = stateHTML("empty", "Профессии не выбраны", "Укажите профессии в config.json рядом с exe (поле professions), и демон начнёт скачивать рецепты.");
		return;
	}
	if (!st.prof || !profs.includes(st.prof)) st.prof = profs[0];
	const tools = segHTML("prof", profs.map(p => [p, PROF_RU[p.toLowerCase()] || p]), st.prof) +
		toggleHTML("priced", "Только с ценой", st.priced, "Скрыть рецепты, у которых нет цены результата или реагента") +
		`<input class="tf-in" id="craft-q" type="search" placeholder="Фильтр рецептов" value="${esc(st.q)}">`;
	const box = tabFrame(body, tools, "Маржа = цена × 0,95 − себестоимость · ▸ раскрыть реагенты");
	bindBar(body, (seg, v) => { st.prof = v; st.open.clear(); renderCraft(body); }, () => { st.priced = !st.priced; renderCraft(body); });
	const qi = body.querySelector("#craft-q");
	qi.addEventListener("input", debounce(() => { st.q = qi.value; drawLast && drawLast(); }, 120));
	let drawLast = null;
	loadingInto(box, 8);
	getDoc("crafting-" + st.prof).then(r => { drawLast = () => draw(r); draw(r); }).catch(e => { if (currentTab === "craft") docError(box, e, "Рецепты"); });
	function draw(r) {
		if (currentTab !== "craft") return;
		const recs = Array.isArray(r.doc.recipes) ? r.doc.recipes : [];
		let rows = recs.map((x, i) => {
			const res = docItem(x.result || {});
			const inst = S.byId.get(res.id);
			const name = !isPlaceholderName(itemName(res)) ? itemName(res) : (x.recipe && x.recipe.name) || itemName(res);
			return {
				key: (x.recipe && x.recipe.spellId) || i, res: { ...res, ruName: res.ruName || name }, recipe: x.recipe || {}, name,
				skill: x.recipe && x.recipe.skillRequired, cost: x.cost, price: x.resultPrice, net: x.netValue, margin: x.margin, ratio: x.marginRatio,
				S: x.resultSalesPerDay, ppd: x.profitPerDay, reagents: x.reagents || [], unpriced: x.unpriced || [], inst,
			};
		});
		const q = st.q.trim().toLowerCase();
		if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q) || (r.res.name || "").toLowerCase().includes(q) || r.reagents.some(g => String(g.ruName || g.name || "").toLowerCase().includes(q)));
		const total = rows.length;
		if (st.priced) rows = rows.filter(r => isNum(r.margin));
		docMeta(r, `${PROF_RU[st.prof.toLowerCase()] || st.prof} · ${rows.length} из ${total}`);
		if (!rows.length) {
			if (marketClosed(r.doc)) return closedOr(box, r.doc);
			box.innerHTML = stateHTML("empty", "Рецептов нет", st.priced && total ? `У всех ${total} рецептов не хватает цены результата или реагента. Снимите «Только с ценой».` : "Под фильтр ничего не попало.");
			return;
		}
		dataTable(box, {
			state: st,
			rows,
			rowId: r => r.res.id,
			expanded: r => st.open.has(r.key),
			onToggle: r => { st.open.has(r.key) ? st.open.delete(r.key) : st.open.add(r.key); },
			expandHTML: r => {
				const lines = r.reagents.map(g => {
					const gi = docItem({ id: g.id, name: g.name, ruName: g.ruName, quality: g.quality });
					return `<tr><td>${itemCell(gi)}</td><td class="num">${num(g.qty)}</td><td class="num">${money(g.price)}</td><td class="num">${isNum(g.price) ? money(g.price * g.qty) : '<span class="na">—</span>'}</td></tr>`;
				}).join("");
				const unp = r.unpriced.length ? `<div class="sub-n">Без цены: ${r.unpriced.map(u => esc(typeof u === "object" ? (u.ruName || u.name || u.id) : u)).join(", ")}</div>` : "";
				return `<table class="rg"><thead><tr><th>Реагент</th><th class="num">Шт</th><th class="num">Цена</th><th class="num">Сумма</th></tr></thead><tbody>${lines}</tbody>
				<tfoot><tr><td>Себестоимость</td><td></td><td></td><td class="num">${money(r.cost)}</td></tr></tfoot></table>${unp}
				<div class="sub-n">${esc(r.recipe.acquisition && r.recipe.acquisition !== "unknown" ? "Где взять: " + ({ trainer: "у учителя", vendor: "у торговца", drop: "добыча", quest: "задание" }[r.recipe.acquisition] || r.recipe.acquisition) : "")}</div>`;
			},
			cols: [
				{ k: "x", t: "", sortable: false, w: "22px", fmt: r => `<span class="xp" title="Реагенты">${st.open.has(r.key) ? "▾" : "▸"}</span>` },
				{ k: "name", t: "Рецепт", get: r => r.name, fmt: r => itemCell(r.res) },
				{ k: "skill", t: "Навык", num: true, fmt: r => num(r.skill) },
				{ k: "cost", t: "Себестоимость", num: true, fmt: r => money(r.cost) },
				{ k: "price", t: "Продажа", num: true, fmt: r => money(r.price) },
				{ k: "net", t: "После 5%", num: true, fmt: r => money(r.net) },
				{ k: "margin", t: "Маржа", num: true, fmt: r => (isNum(r.margin) ? `<span class="${r.margin > 0 ? "pos" : "neg"}">${money(r.margin)}</span>` : '<span class="na">—</span>') },
				{ k: "ratio", t: "Маржа %", num: true, fmt: r => (isNum(r.ratio) ? `<span class="${r.ratio > 0 ? "pos" : "neg"}">${pct(r.ratio, 0)}</span>` : '<span class="na">—</span>'), title: "маржа / себестоимость" },
				{ k: "S", t: "Прод/день", num: true, fmt: r => (isNum(r.S) ? num(r.S, 1) : '<span class="na" title="нет оценки продаж">—</span>') },
				{ k: "ppd", t: "Прибыль/день", num: true, fmt: r => (isNum(r.ppd) ? `<b class="${r.ppd > 0 ? "pos" : "neg"}">${money(r.ppd, { compact: true })}</b>` : '<span class="na">—</span>'), title: "маржа × продажи в день: потолок, если снабжать весь рынок" },
			],
		});
	}
}

// ---------- Сигналы ----------

function renderSignals(body) {
	const st = TS.signals;
	const tools = toggleHTML("now", "Срабатывает сейчас", st.now) + toggleHTML("tested", "Только проверенные", st.tested, "≥5 оценённых срабатываний");
	const box = tabFrame(body, tools, "");
	bindBar(body, null, t => { st[t] = !st[t]; renderSignals(body); });
	loadingInto(box, 8);
	getDoc("signals").then(draw).catch(e => { if (currentTab === "signals") docError(box, e, "Сигналы"); });
	function draw(r) {
		if (currentTab !== "signals") return;
		const f = r.doc.filters || {};
		body.querySelector(".tf-bar").insertAdjacentHTML("beforeend", `<span class="tf-note">Правило: дневная медиана на ${f.discount ?? 20}%+ ниже средней 30д · победа: возврат к базе за ${f.days ?? 7} дн · 180 дней истории</span>`);
		let rows = (r.doc.signals || []).map(s => {
			const it = docItem(s.item);
			const n = s.fires || 0, w = s.wins || 0;
			const [lo, hi] = wilson(w, n);
			return { it, n, w, rate: isNum(s.hitRate) ? s.hitRate : n ? w / n : null, lo, hi, firing: s.firingNow ? 1 : 0, tested: !!s.tested, median: s.median, base: s.base, disc: isNum(s.median) && isNum(s.base) && s.base ? 1 - s.median / s.base : null };
		});
		if (st.now) rows = rows.filter(x => x.firing);
		if (st.tested) rows = rows.filter(x => x.tested);
		const stale = isStale();
		docMeta(r, `${rows.length} ${plural(rows.length, "сигнал", "сигнала", "сигналов")}${stale ? " · данные старше 6 ч" : ""}`);
		if (!rows.length) {
			if (marketClosed(r.doc)) return closedOr(box, r.doc);
			box.innerHTML = stateHTML("empty", "Сигналов нет", st.now ? "Сейчас правило не срабатывает ни на одном предмете." : "AHledger не нашёл предметов с историей срабатываний.");
			return;
		}
		dataTable(box, {
			state: st,
			rows,
			rowId: x => x.it.id,
			rowCls: () => (stale ? "grey" : ""),
			cols: [
				{ k: "name", t: "Предмет", get: x => itemName(x.it), fmt: x => itemCell(x.it) },
				{ k: "firing", t: "Сейчас", fmt: x => (x.firing ? `<span class="tag ${stale ? "" : "cheap"}">срабатывает</span>` : '<span class="na">—</span>') },
				{ k: "n", t: "Срабат.", num: true, fmt: x => num(x.n) },
				{ k: "w", t: "Побед", num: true, fmt: x => num(x.w) },
				{ k: "rate", t: "Успех", num: true, fmt: x => (x.n < 10 ? `<span class="dim">${pct(x.rate, 0, false)}</span> <span class="tag">мало данных</span>` : `<b>${pct(x.rate, 0, false)}</b>`) },
				{ k: "lo", t: "Уилсон 95%", num: true, title: "Доверительный интервал доли побед; сортировка по нижней границе", fmt: x => `<span class="wb"><span class="wb-r" style="left:${x.lo * 100}%;width:${Math.max(1, (x.hi - x.lo) * 100)}%"></span><span class="wb-p" style="left:${(x.rate || 0) * 100}%"></span></span><span class="wb-t">${nf0.format(x.lo * 100)}–${nf0.format(x.hi * 100)}%</span>` },
				{ k: "median", t: "Медиана", num: true, fmt: x => money(x.median) },
				{ k: "base", t: "База 30д", num: true, fmt: x => money(x.base) },
				{ k: "disc", t: "Ниже базы", num: true, fmt: x => `<span class="${stale ? "" : discCls(x.disc)}">${pct(x.disc, 0, false)}</span>` },
				{ k: "tested", t: "Проверен", get: x => (x.tested ? 1 : 0), fmt: x => (x.tested ? "да" : '<span class="dim">нет</span>') },
			],
		});
	}
}

// ---------- Распыление ----------

function renderDisenchant(body) {
	const st = TS.de;
	const box = tabFrame(body, "", "Прибыль = ожидаемые материалы × 0,95 − самый дешёвый лот · среднее по многим распылениям");
	loadingInto(box, 6);
	getDoc("disenchant").then(draw).catch(e => { if (currentTab === "de") docError(box, e, "Распыление"); });
	function draw(r) {
		if (currentTab !== "de") return;
		const d = r.doc;
		const rows = (d.opportunities || []).map(o => {
			const it = docItem(o.item || { id: o.id, name: o.name });
			const price = o.minBuyout ?? o.price ?? o.buyout ?? o.cheapest ?? o.min;
			const net = o.netValue ?? (isNum(o.disenchantValue) ? o.disenchantValue * CUT : null);
			return { it, price, dv: o.disenchantValue, net, profit: o.profit ?? (isNum(net) && isNum(price) ? net - price : null), mp: o.materialsPriced, y: o.yields ?? o.yieldCount, roi: isNum(o.profit) && price ? o.profit / price : null };
		});
		const mats = (d.materials || []).map(m => ({ it: docItem(m.item || { id: m.id, name: m.name, ruName: m.ruName, quality: m.quality }), v: m.median ?? m.price ?? m.value }));
		docMeta(r, `${rows.length} ${plural(rows.length, "предмет", "предмета", "предметов")}`);
		const side = mats.length ? `<div class="de-mats"><div class="sec-h"><span>Материалы</span><span class="sec-m">медиана</span></div>${mats.map(m => `<div class="kvrow">${itemCell(m.it)}<span class="num">${money(m.v)}</span></div>`).join("")}</div>` : "";
		if (!rows.length) {
			if (marketClosed(d)) return closedOr(box, d);
			box.innerHTML = `<div class="split">${stateHTML("empty", "Выгодного распыления нет", "Сейчас нет предметов, которые дешевле своих ожидаемых материалов после 5% комиссии. AHledger показывает только строки с положительной прибылью.")}${side}</div>`;
			return;
		}
		box.innerHTML = `<div class="split"><div class="split-main"></div>${side}</div>`;
		dataTable(box.querySelector(".split-main"), {
			state: st,
			rows,
			rowId: x => x.it.id,
			cols: [
				{ k: "name", t: "Предмет", get: x => itemName(x.it), fmt: x => itemCell(x.it) },
				{ k: "price", t: "Цена лота", num: true, fmt: x => money(x.price) },
				{ k: "dv", t: "Материалы", num: true, fmt: x => money(x.dv), title: "Ожидаемая стоимость по медианам материалов" },
				{ k: "net", t: "После 5%", num: true, fmt: x => money(x.net) },
				{ k: "profit", t: "Прибыль", num: true, fmt: x => `<b class="${x.profit > 0 ? "pos" : "neg"}">${money(x.profit)}</b>` },
				{ k: "roi", t: "ROI", num: true, fmt: x => pct(x.roi, 0) },
				{ k: "mp", t: "Мат. с ценой", num: true, fmt: x => (isNum(x.mp) ? num(x.mp) + (isNum(x.y) ? " из " + num(x.y) : "") : "—"), title: "Меньше полного числа: стоимость занижена" },
			],
		});
	}
}

// ---------- Обзор рынка ----------

let ovChart = null;
function renderOverview(body) {
	if (ovChart) { ovChart.destroy(); ovChart = null; }
	const box = tabFrame(body, "", "");
	box.classList.add("ov-wrap");
	box.innerHTML = `<div class="ov">
		<div class="ov-a card"><div class="sec-h"><span>Размер экономики</span><span class="sec-m" id="ov-asof"></span></div><div id="ov-kpi" class="kpis">${skeletonRows(2, 4)}</div><div id="ov-chart" class="ov-chart"></div></div>
		<div class="ov-b card"><div class="sec-h"><span>Лидеры роста</span><span class="sec-m">Δ24ч</span></div><div id="ov-up"></div></div>
		<div class="ov-c card"><div class="sec-h"><span>Лидеры падения</span><span class="sec-m">Δ24ч</span></div><div id="ov-down"></div></div>
		<div class="ov-d card"><div class="sec-h"><span>Структура</span><span class="sec-m">доля стоимости</span></div><div id="ov-cls"></div><div class="sec-h sub"><span>Шоки предложения</span><span class="sec-m">|σ| ≥ 2</span></div><div id="ov-shock"></div><div class="sec-h sub"><span>Цены по дням недели</span></div><div id="ov-wd"></div></div>
	</div>`;
	// Лидеры из вотчлиста.
	const movers = S.instruments.filter(x => x.ind && isNum(x.ind.change24h));
	const mv = (list) => list.length ? list.map(x => `<div class="mv lk" data-id="${x.itemId}">${itemCell(x)}<span class="num">${money(x.min, { compact: true })}</span><span class="num ${signCls(x.ind.change24h)}">${pct(x.ind.change24h)}</span></div>`).join("") : `<div class="na pad">Нет изменений за 24 ч</div>`;
	$("#ov-up", box).innerHTML = mv([...movers].filter(x => x.ind.change24h > 0).sort((a, b) => b.ind.change24h - a.ind.change24h).slice(0, 9));
	$("#ov-down", box).innerHTML = mv([...movers].filter(x => x.ind.change24h < 0).sort((a, b) => a.ind.change24h - b.ind.change24h).slice(0, 9));
	box.addEventListener("click", e => { const r = e.target.closest(".lk[data-id]"); if (r) openItem(r.dataset.id); });

	getDoc("economy").then(r => {
		if (currentTab !== "overview") return;
		const d = r.doc, c = d.current || {};
		docMeta(r, d.marketLabel || "");
		if (!d.current) { $("#ov-kpi", box).innerHTML = stateHTML(marketClosed(d) ? "closed" : "empty", marketClosed(d) ? "Рынок не открыт" : "Нет данных", "AHledger ещё не посчитал экономику этого рынка."); return; }
		$("#ov-asof", box).textContent = c.observedAt ? "срез " + ago(c.observedAt) : "";
		const kpi = (k, v, sub) => `<div class="kpi"><div class="kpi-k">${k}</div><div class="kpi-v">${v}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ""}</div>`;
		$("#ov-kpi", box).innerHTML =
			kpi("Выставлено на сумму", money(c.value, { compact: true }), isNum(d.weekChange) ? `<span class="${signCls(d.weekChange)}">${pct(d.weekChange)}</span> к прошлой неделе` : "") +
			kpi("По минимальным ценам", money(c.valueLow, { compact: true }), "если считать по самому дешёвому лоту") +
			kpi("Лотов", compact(c.auctions), isNum(d.weekAgo && d.weekAgo.auctions) ? `неделю назад ${compact(d.weekAgo.auctions)}` : "") +
			kpi("Единиц", compact(c.units), `${num(c.items)} предметов · ${num(c.contributors)} ${plural(c.contributors || 0, "сканер", "сканера", "сканеров")}`);
		const daily = (d.daily || []).filter(x => isNum(x.value));
		const cb = $("#ov-chart", box);
		if (daily.length) {
			const xs = daily.map(x => toSec(x.day + "T12:00:00Z"));
			ovChart = renderAreaChart(cb, xs, daily.map(x => x.value), { fmt: v => moneyText(v, true), color: css("--accent") });
		} else cb.innerHTML = '<div class="na pad">Нет дневной истории</div>';
		const cls = (c.classes || []).slice(0, 8);
		$("#ov-cls", box).innerHTML = cls.map(k => `<div class="bar-row" title="${esc(k.name)}: ${moneyText(k.value, true)}, ${num(k.units)} шт"><span class="br-n">${esc(CLASS_RU[k.name] || k.name)}</span><span class="br-b"><span style="width:${(k.share * 100 / (cls[0].share || 1)).toFixed(1)}%"></span></span><span class="br-v">${pct(k.share, 0, false)}</span></div>`).join("");
	}).catch(e => { if (currentTab === "overview") $("#ov-kpi", box).innerHTML = stateHTML("error", "Экономика недоступна", esc(e.message)); });

	getDoc("structure").then(r => {
		if (currentTab !== "overview") return;
		const d = r.doc;
		const shockIds = new Set((d.supplyShocks || []).map(x => (typeof x === "object" ? x.id : x)));
		const shocks = (d.items || []).filter(x => shockIds.has(x.item && x.item.id) || (isNum(x.supplyShock) && Math.abs(x.supplyShock) >= 2));
		$("#ov-shock", box).innerHTML = shocks.length ? shocks.slice(0, 6).map(x => { const it = docItem(x.item); return `<div class="mv lk" data-id="${it.id}">${itemCell(it)}<span class="num">${num(x.depth)} шт</span><span class="num ${x.supplyShock > 0 ? "dear" : "cheap"}">${x.supplyShock > 0 ? "+" : "−"}${nf1.format(Math.abs(x.supplyShock))}σ</span></div>`; }).join("") : '<div class="na pad">Шоков предложения нет</div>';
		const wd = (d.weekdays || []).slice().sort((a, b) => ((a.dow + 6) % 7) - ((b.dow + 6) % 7));
		$("#ov-wd", box).innerHTML = wd.length ? `<div class="wd">${wd.map(w => { const dv = w.priceIndex - 1; return `<div class="wd-c" title="${WD_SHORT[w.dow]}: цены ${pct(dv)} к неделе, лотов ×${nf2.format(w.listingIndex)} · ${w.days} дн"><span class="wd-b ${dv < 0 ? "cheap" : "dear"}" style="height:${Math.min(100, Math.abs(dv) / 0.06 * 100)}%"></span><span class="wd-l">${WD_SHORT[w.dow]}</span><span class="wd-v ${dv < 0 ? "cheap" : "dear"}">${pct(dv, 0)}</span></div>`; }).join("")}</div>` : '<div class="na pad">—</div>';
	}).catch(() => { $("#ov-shock", box).innerHTML = '<div class="na pad">Структура недоступна</div>'; });
}

const CLASS_RU = {
	"Trade Goods": "Хозтовары", Armor: "Доспехи", Consumable: "Расходуемые", Weapon: "Оружие", Recipe: "Рецепты", Miscellaneous: "Разное",
	Quest: "Задания", Quiver: "Колчаны", Container: "Сумки", Projectile: "Боеприпасы", Reagent: "Реагенты", Gem: "Камни", Key: "Ключи",
};

// ---------- Прогнозы ----------

function renderForecasts(body) {
	const st = TS.fc;
	const box = tabFrame(body, '<span class="tag exp">экспериментально</span>', "Предметы, где прогноз min-цены на 3 дня после 5% выше текущего минимума. Доходность меньше разброса — почти шум.");
	loadingInto(box, 8);
	api("/api/opportunities").then(list => {
		if (currentTab !== "fc") return;
		list = Array.isArray(list) ? list : [];
		setMeta(`${list.length} ${plural(list.length, "идея", "идеи", "идей")} · модель демона`);
		if (!list.length) { box.innerHTML = stateHTML("wait", "Прогнозов пока нет", "Для прогноза нужно хотя бы 3 дня собственной истории демона: по снимку каждые 15 минут."); return; }
		dataTable(box, {
			state: st,
			rows: list,
			rowId: x => x.itemId,
			cols: [
				{ k: "name", t: "Предмет", get: x => itemName(x), fmt: x => itemCell(x) },
				{ k: "min", t: "Мин сейчас", num: true, fmt: x => money(x.min) },
				{ k: "sellMid", t: "Прогноз", num: true, fmt: x => money(x.sellMid) },
				{ k: "sellLow", t: "Нижняя 80%", num: true, fmt: x => money(x.sellLow) },
				{ k: "sellAt", t: "Когда", num: true, fmt: x => (x.sellAt ? fmtDate(x.sellAt) : "—") },
				{ k: "gain", t: "Доходность", num: true, fmt: x => `<b class="${x.gain > 0 ? "pos" : "neg"}">${pct(x.gain, 0)}</b>`, title: "прогноз × 0,95 / мин − 1" },
				{ k: "trendPerDay", t: "Тренд/день", num: true, fmt: x => `<span class="${signCls(x.trendPerDay)}">${pct(x.trendPerDay, 1)}</span>` },
				{ k: "volatility", t: "Разброс", num: true, fmt: x => `<span class="${isNum(x.gain) && isNum(x.volatility) && x.gain < x.volatility ? "warn" : ""}">±${pct(x.volatility, 0, false)}</span>` },
				{ k: "cheap", t: "Дешевле всего", get: x => x.cheapest ? x.cheapest.weekday * 24 + x.cheapest.hour : null, fmt: x => (x.cheapest ? `${WD_SHORT[x.cheapest.weekday]} ${String(x.cheapest.hour).padStart(2, "0")}:00` : "—") },
				{ k: "salesPerDay", t: "Прод/день", num: true, fmt: x => (isNum(x.salesPerDay) && x.salesPerDay > 0 ? num(x.salesPerDay, 1) : '<span class="na">—</span>') },
			],
		});
	}).catch(e => { if (currentTab === "fc") box.innerHTML = e.status === 404 ? stateHTML("wait", "Прогнозы недоступны", "Эта версия демона не отдаёт /api/opportunities.") : stateHTML("error", "Ошибка", esc(e.message)); });
}

// ---------- Калькулятор ----------

function calcPrefill() {
	const c = TS.calc;
	const it = S.item;
	if (!it || c.id === S.sel) return;
	const l = it.latest || {};
	c.id = S.sel;
	c.B = isNum(l.min) ? moneyText(l.min) : "";
	const t = [l.median30, l.median7].filter(v => isNum(v) && v > 0);
	c.P = t.length ? moneyText(Math.min(...t)) : isNum(l.median) ? moneyText(l.median) : "";
	c.dep = "";
}

function renderCalc(body) {
	const box = tabFrame(body, "", "net = q × (P × 0,95 − B) · ROI = net / (q × B) · безубыточность = B / 0,95 · T = (впереди + q) / S");
	const it = S.item;
	if (!S.sel || !it) { box.innerHTML = stateHTML("empty", "Выберите предмет", "Калькулятор заполнится ценами выбранного предмета."); return; }
	calcPrefill();
	const c = TS.calc;
	const meta = it.item || {};
	setMeta(`для: ${esc(itemName(meta))}`);
	box.innerHTML = `<div class="calc">
		<form class="calc-in" autocomplete="off" onsubmit="return false">
			<div class="calc-item">${iconHTML(meta, 28)}<div>${nameHTML(meta)}<div class="dim">мин ${money(it.latest && it.latest.min)} · медиана 30д ${money(it.latest && it.latest.median30)}</div></div></div>
			<label><span>Покупка B, за шт</span><input name="B" value="${esc(c.B)}" placeholder="12з 34с"></label>
			<label><span>Количество q</span><input name="q" value="${esc(c.q)}" inputmode="numeric"></label>
			<label><span>Цель P, за шт</span><input name="P" value="${esc(c.P)}" placeholder="15з"></label>
			<label><span>Срок лота</span><div class="seg sm" data-seg="dur">${[12, 24, 48].map(h => `<button type="button" class="${c.dur === h ? "on" : ""}" data-v="${h}">${h} ч</button>`).join("")}</div></label>
			<label><span>Депозит за выставление</span><input name="dep" value="${esc(c.dep)}" placeholder="${isNum(meta.vendorSell) && meta.vendorSell > 0 ? "вендор " + moneyText(meta.vendorSell) + "/шт" : "0"}"></label>
			<div class="calc-hint">Деньги можно вводить как «12з 34с 5м», «12.5» (золото) или «45с». Депозит теряется, если лот не продастся за срок.</div>
			<button type="button" class="btn ghost" id="calc-reset">Заполнить из предмета</button>
		</form>
		<div class="calc-out" id="calc-out"></div>
	</div>`;
	const form = box.querySelector("form");
	const upd = () => {
		c.B = form.B.value; c.q = form.q.value; c.P = form.P.value; c.dep = form.dep.value;
		$("#calc-out", box).innerHTML = calcOut();
	};
	form.addEventListener("input", upd);
	form.querySelector("[data-seg=dur]").addEventListener("click", e => {
		const b = e.target.closest("button"); if (!b) return;
		c.dur = Number(b.dataset.v);
		form.querySelectorAll("[data-seg=dur] button").forEach(x => x.classList.toggle("on", x === b));
		upd();
	});
	$("#calc-reset", box).addEventListener("click", () => { c.id = null; renderCalc(body); });
	upd();
}

function calcOut() {
	const c = TS.calc;
	const it = S.item;
	const l = it.latest || {};
	const B = parseMoney(c.B), P = parseMoney(c.P);
	const q = Math.max(0, Math.round(Number(String(c.q).replace(/\s/g, "")) || 0));
	const dep = parseMoney(c.dep) || 0;
	if (!isNum(B) || !isNum(P) || !q || B <= 0) return stateHTML("empty", "Введите покупку, количество и цель", "");
	const net = q * (P * CUT - B);
	const roi = net / (q * B);
	const be = B / CUT;
	const S_ = isNum(l.salesPerDay) && l.salesPerDay > 0 ? l.salesPerDay : null;
	const book = (it.book || []).filter(b => isNum(b.price) && isNum(b.qty));
	const ahead = book.length ? book.filter(b => b.price < P).reduce((a, b) => a + b.qty, 0) : isNum(l.qty) ? l.qty : null;
	const aheadSrc = book.length ? "по своему стакану: лоты дешевле цели" : "весь выставленный объём (своего скана нет)";
	const T = S_ && isNum(ahead) ? (ahead + q) / S_ : null;
	const relists = isNum(T) ? Math.max(1, Math.ceil((T * 24) / c.dur)) : null;
	const depLoss = isNum(relists) ? (relists - 1) * dep : null;
	const netAfter = isNum(depLoss) ? net - depLoss : null;
	const last = it.series.length ? it.series[it.series.length - 1] : {};
	const sens = [["Медиана 30д", l.median30], ["Медиана 7д", l.median7], ["p25", last.p25], ["p75", last.p75], ["Ваша цель", P]]
		.filter(([, v]) => isNum(v) && v > 0)
		.map(([k, v]) => { const n = q * (v * CUT - B); return `<tr${k === "Ваша цель" ? ' class="me"' : ""}><td>${k}</td><td class="num">${money(v)}</td><td class="num"><b class="${n > 0 ? "pos" : "neg"}">${money(n)}</b></td><td class="num ${n > 0 ? "pos" : "neg"}">${pct(n / (q * B), 0)}</td></tr>`; }).join("");
	const warns = [];
	if (isNum(l.high30) && P > l.high30) warns.push(["warn", `Цель выше всей истории 30д (макс ${moneyText(l.high30)}).`]);
	if (P < be) warns.push(["bad", `Цель ниже безубыточности ${moneyText(Math.ceil(be))}: после 5% комиссии это убыток.`]);
	if (!S_) warns.push(["thin", "Нет оценки продаж в день: время продажи неизвестно."]);
	if (isNum(T) && T * 24 > c.dur) warns.push(["warn", `Продажа займёт ~${dur(T * 86400)}, дольше срока лота ${c.dur} ч: придётся перевыставлять ${relists - 1} раз.`]);
	const big = (k, v, sub, cls = "") => `<div class="co"><div class="co-k">${k}</div><div class="co-v ${cls}">${v}</div>${sub ? `<div class="co-s">${sub}</div>` : ""}</div>`;
	return `<div class="co-grid">
		${big("Чистая прибыль", money(net), `${num(q)} шт × (${moneyText(P, true)} × 0,95 − ${moneyText(B, true)})`, net > 0 ? "pos" : "neg")}
		${big("ROI", pct(roi, 1), `вложено ${moneyText(q * B, true)}`, roi > 0 ? "pos" : "neg")}
		${big("Безубыточность", money(Math.ceil(be)), "минимальная цена продажи за шт")}
		${big("Время продажи", isNum(T) ? dur(T * 86400) : "—", isNum(ahead) ? `впереди ${num(ahead)} шт · ${aheadSrc}` : "нет данных об объёме")}
		${dep ? big("С учётом перевыставлений", isNum(netAfter) ? money(netAfter) : "—", isNum(relists) ? `${relists} ${plural(relists, "выставление", "выставления", "выставлений")}, потеря депозита ${moneyText(depLoss, true)}` : "", isNum(netAfter) ? (netAfter > 0 ? "pos" : "neg") : "") : ""}
	</div>
	${warns.map(([c, t]) => `<div class="notice ${c} sm">${t}</div>`).join("")}
	<div class="sec-h sub"><span>Чувствительность</span><span class="sec-m">net при разных ценах продажи</span></div>
	<table class="dt sens"><thead><tr><th>Цена продажи</th><th class="num">P</th><th class="num">Net</th><th class="num">ROI</th></tr></thead><tbody>${sens}</tbody></table>`;
}

const TABS = [
	{ id: "flips", title: "Флипы", render: renderFlips },
	{ id: "craft", title: "Крафт", render: renderCraft },
	{ id: "signals", title: "Сигналы", render: renderSignals },
	{ id: "de", title: "Распыление", render: renderDisenchant },
	{ id: "overview", title: "Обзор рынка", render: renderOverview },
	{ id: "fc", title: "Прогнозы", render: renderForecasts, exp: true },
	{ id: "calc", title: "Калькулятор", render: renderCalc },
];
