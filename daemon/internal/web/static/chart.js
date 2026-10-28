"use strict";
// График предмета: ценовая панель (min, median, полоса p25–p75, уровни 30д, прогноз, свои сканы, свечи)
// и нижняя панель количества. Обе панели uPlot делят одну ось X и курсор.

const RANGE_SEC = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "90d": 90 * 86400 };
const DAY = 86400;

// Сколько показывать прогноза справа от «сейчас»: только для коротких диапазонов.
const FC_EXT = { "24h": 10 * 3600, "7d": 3 * DAY };

function chartColors() {
	return {
		min: css("--c-min"), median: css("--c-median"), band: css("--c-band"), m7: css("--c-m7"), m30: css("--c-m30"),
		low: css("--cheap"), high: css("--dear"), fc: css("--c-fc"), fcBand: css("--c-fc-band"), own: css("--c-own"),
		qty: css("--c-qty"), auc: css("--c-auc"), grid: css("--c-grid"), axis: css("--tx-3"), up: css("--up"), down: css("--down"),
		bg: css("--bg-1"), tx: css("--tx-1"), line: css("--line-strong"), now: css("--tx-3"),
	};
}

// Дневные свечи по min из снимков демона: O = первый снимок дня, C = последний. Свеча при ≥4 снимках.
function dailyCandles(snaps) {
	const days = new Map();
	for (const s of snaps || []) {
		if (!isNum(s.min) || s.min <= 0) continue;
		const d = new Date(s.t * 1000);
		const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
		if (!days.has(key)) days.set(key, []);
		days.get(key).push(s);
	}
	const out = [];
	for (const [day, arr] of [...days.entries()].sort((a, b) => a[0] - b[0])) {
		arr.sort((a, b) => a.t - b.t);
		const mins = arr.map(s => s.min);
		out.push({ t: day + DAY / 2, day, n: arr.length, o: arr[0].min, c: arr[arr.length - 1].min, h: Math.max(...mins), l: Math.min(...mins), ok: arr.length >= 4 });
	}
	return out;
}

function candlesAvailable(data, range) {
	if (range === "24h") return { ok: false, why: "На 24 часах дневная свеча одна: смотрите линию." };
	const c = dailyCandles(data && data.snapshots);
	const good = c.filter(x => x.ok).length;
	if (!good) return { ok: false, why: "Свечи строятся только из своих снимков демона, нужно ≥4 снимков за день. Таких дней пока нет." };
	return { ok: true, why: `Дневные свечи по min-buyout из ${num((data.snapshots || []).length)} снимков демона` };
}

// Сезонность 24×7 из часового ряда: median(min в ячейке)/среднее − 1, n — число точек.
function seasonality(series) {
	const cells = [...Array(7)].map(() => [...Array(24)].map(() => []));
	const all = [];
	for (const p of series || []) {
		if (!isNum(p.min) || p.min <= 0) continue;
		const d = new Date(p.t * 1000);
		cells[d.getDay()][d.getHours()].push(p.min);
		all.push(p.min);
	}
	if (all.length < 6) return null;
	const mean = all.reduce((a, b) => a + b, 0) / all.length;
	return cells.map(row => row.map(v => ({ n: v.length, d: v.length ? median(v) / mean - 1 : null })));
}

// Строит совмещённые массивы для uPlot.
function buildChartData(data, fc, o) {
	const span = RANGE_SEC[o.range] || RANGE_SEC["7d"];
	const to = isNum(data.to) && data.to > 0 ? data.to : nowSec();
	const from = isNum(data.from) && data.from > 0 ? data.from : to - span;
	const series = (data.series || []).filter(p => p.t >= from - 60 && p.t <= to + 60);
	const own = o.own ? (data.own || []).filter(p => p.t >= from && p.t <= to) : [];
	const fcOn = o.forecast && fc && fc.ok && Array.isArray(fc.points) && fc.points.length && FC_EXT[o.range];
	const fcPts = fcOn ? fc.points.filter(p => p.t > to && p.t <= to + FC_EXT[o.range]) : [];
	const candles = o.mode === "candles" ? dailyCandles(data.snapshots).filter(c => c.day + DAY > from) : [];
	candles.forEach(c => { c.t = Math.min(Math.max(c.t, from), to); });
	const xMax = fcPts.length ? fcPts[fcPts.length - 1].t : to;

	const tset = new Set();
	series.forEach(p => tset.add(p.t));
	own.forEach(p => tset.add(p.t));
	candles.forEach(c => tset.add(c.t));
	if (fcPts.length) { tset.add(to); fcPts.forEach(p => tset.add(p.t)); }
	const xs = [...tset].sort((a, b) => a - b);
	const ix = new Map(xs.map((t, i) => [t, i]));
	const col = () => new Array(xs.length).fill(null);
	const d = { xs, min: col(), median: col(), p25: col(), p75: col(), qty: col(), auc: col(), fcMid: col(), fcLo: col(), fcHi: col(), own: col(), cHi: col(), cLo: col() };
	const pos = v => (isNum(v) && v > 0 ? v : null);
	for (const p of series) {
		const i = ix.get(p.t);
		d.min[i] = pos(p.min); d.median[i] = pos(p.median); d.p25[i] = pos(p.p25); d.p75[i] = pos(p.p75);
		d.qty[i] = isNum(p.qty) ? p.qty : null; d.auc[i] = isNum(p.auctions) ? p.auctions : null;
	}
	for (const p of own) d.own[ix.get(p.t)] = pos(p.min);
	const candleAt = new Map();
	for (const c of candles) {
		const i = ix.get(c.t);
		d.cHi[i] = c.h; d.cLo[i] = c.l;
		candleAt.set(i, c);
	}
	if (fcPts.length) {
		// Прогноз начинается от последней известной цены, чтобы не было разрыва.
		const i0 = ix.get(to);
		const lastMin = data.latest && pos(data.latest.min);
		if (lastMin && d.fcMid[i0] === null) { d.fcMid[i0] = lastMin; d.fcLo[i0] = lastMin; d.fcHi[i0] = lastMin; }
		for (const p of fcPts) { const i = ix.get(p.t); d.fcMid[i] = pos(p.mid); d.fcLo[i] = pos(p.low); d.fcHi[i] = pos(p.high); }
	}
	return { d, from, to, xMax, candleAt, fcOn: fcPts.length > 0, nSeries: series.length };
}

function fmtAxisTime(t, incr) {
	const d = new Date(t * 1000);
	if (incr < DAY) {
		if (d.getHours() === 0 && d.getMinutes() === 0) return d.getDate() + " " + MON_SHORT[d.getMonth()];
		return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
	}
	return d.getDate() + " " + MON_SHORT[d.getMonth()];
}

// Ценовая метка на правой оси (как в TradingView).
function axisTag(ctx, u, y, text, bg, fg) {
	const r = uPlot.pxRatio;
	ctx.save();
	ctx.font = `${600} ${Math.round(10.5 * r)}px ${css("--font-num")}`;
	const x = u.bbox.left + u.bbox.width + 1 * r;
	const w = Math.min(ctx.measureText(text).width + 10 * r, u.width * r - x);
	const h = 16 * r;
	ctx.fillStyle = bg;
	ctx.beginPath();
	ctx.moveTo(x, y);
	ctx.lineTo(x + 4 * r, y - h / 2);
	ctx.lineTo(x + w + 4 * r, y - h / 2);
	ctx.lineTo(x + w + 4 * r, y + h / 2);
	ctx.lineTo(x + 4 * r, y + h / 2);
	ctx.closePath();
	ctx.fill();
	ctx.fillStyle = fg;
	ctx.textBaseline = "middle";
	ctx.fillText(text, x + 8 * r, y + 0.5 * r);
	ctx.restore();
}

// Главная функция: рисует график в box. Возвращает {destroy}.
function renderItemChart(box, data, fc, o) {
	const C = chartColors();
	const B = buildChartData(data, fc, o);
	const { d } = B;
	const latest = data.latest || {};
	const r = uPlot.pxRatio;
	box.innerHTML = "";
	const main = el("div", { class: "ch-main" });
	const vol = el("div", { class: "ch-vol" });
	const legend = el("div", { class: "ch-legend" });
	const volLabel = el("div", { class: "ch-vol-label", html: `<span class="sw" style="background:${C.qty}"></span>Количество <span class="sw ln" style="background:${C.auc}"></span>Аукционы <span class="dim">· выставлено, не продажи</span>` });
	const xtag = el("div", { class: "ch-xtag" });
	const ytag = el("div", { class: "ch-ytag" });
	box.append(main, vol, legend);
	vol.append(volLabel);
	main.append(xtag, ytag);

	const sparse = B.nSeries < 30 || (data.ind && isNum(data.ind.histDays) && data.ind.histDays < 1);
	const candleMode = o.mode === "candles" && B.candleAt.size > 0;
	const levels = [];
	if (o.medians) {
		if (isNum(latest.median7)) levels.push({ v: latest.median7, c: C.m7, dash: [5, 4], label: "M7", w: 1.2 });
		if (isNum(latest.median30)) levels.push({ v: latest.median30, c: C.m30, dash: [5, 4], label: "M30", w: 1.2 });
	}
	if (o.corridor) {
		if (isNum(latest.low30)) levels.push({ v: latest.low30, c: C.low, dash: [], label: "L30", w: 1, edge: true });
		if (isNum(latest.high30)) levels.push({ v: latest.high30, c: C.high, dash: [], label: "H30", w: 1, edge: true });
	}

	const sizeOf = () => {
		const w = Math.max(320, box.clientWidth);
		const h = Math.max(140, box.clientHeight);
		const vh = Math.max(50, Math.round(h * 0.25));
		return { w, mh: h - vh, vh };
	};
	const sz = sizeOf();

	const xRange = [B.from, B.xMax];
	const moneyVal = (u, v) => (v == null ? "—" : moneyText(v, true));
	const gradFill = (u) => {
		const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
		g.addColorStop(0, C.min + "2e");
		g.addColorStop(1, C.min + "00");
		return g;
	};

	// Шкалу Y задают min, медиана, свои сканы, свечи и прогноз. Выбросы полосы p25–p75 её не раздувают:
	// полоса учитывается только в пределах 30% от основного диапазона, остальное обрезается краем.
	const core = [d.min, d.median, d.own, d.cHi, d.cLo, d.fcMid].flat().filter(v => isNum(v) && v > 0);
	const coreLo = core.length ? Math.min(...core) : null, coreHi = core.length ? Math.max(...core) : null;
	const yRange = (u, mn, mx) => {
		const lv = levels.filter(l => !l.edge).map(l => l.v);
		if (coreLo !== null) {
			const span = coreHi - coreLo || coreHi * 0.1;
			const band = (o.band ? d.p25.concat(d.p75) : []).concat(d.fcLo, d.fcHi).filter(v => isNum(v) && v > 0);
			const bLo = band.length ? Math.min(...band) : coreLo, bHi = band.length ? Math.max(...band) : coreHi;
			mn = Math.max(Math.min(coreLo, bLo), coreLo - span * 0.3);
			mx = Math.min(Math.max(coreHi, bHi), coreHi + span * 0.3);
		}
		if (!isNum(mn) || !isNum(mx)) { if (!lv.length) return [1, 100]; mn = Math.min(...lv); mx = Math.max(...lv); }
		mn = Math.min(mn, ...lv); mx = Math.max(mx, ...lv);
		if (o.log) {
			mn = Math.max(1, mn);
			const lo = Math.log10(mn), hi = Math.log10(Math.max(mx, mn * 1.02));
			const pad = (hi - lo) * 0.08 + 0.01;
			return [Math.pow(10, lo - pad), Math.pow(10, hi + pad)];
		}
		const span = mx - mn || mx * 0.1 || 1;
		return [Math.max(0, mn - span * 0.1), mx + span * 0.12];
	};

	// Ось X всегда [from, to]; явный зум мышью сохраняется, двойной клик (авто по данным) возвращает [from, to].
	const dMin = d.xs[0], dMax = d.xs[d.xs.length - 1];
	const xRangeFn = (u, mn, mx) => (mn == null || mx == null || (mn === dMin && mx === dMax) || mx - mn < 60 ? xRange : [mn, mx]);
	const syncKey = "fg-item";
	let syncing = false;
	const resetX = (u) => { u.setScale("x", { min: xRange[0], max: xRange[1] }); };
	const cursorBase = {
		sync: { key: syncKey, setSeries: false },
		points: { size: 7, width: 2, fill: C.bg },
		drag: { x: true, y: false, setScale: true },
			};

	const priceSeries = [
		{},
		{ label: "p25", stroke: "transparent", show: !!o.band, points: { show: false }, spanGaps: true, value: moneyVal },
		{ label: "p75", stroke: "transparent", show: !!o.band, points: { show: false }, spanGaps: true, value: moneyVal },
		{ label: "Медиана", stroke: C.median, width: 1.25, spanGaps: true, value: moneyVal, points: { show: sparse, size: 5, fill: C.median }, ...(o.pointsOnly ? { paths: () => null } : {}) },
		candleMode
			? { label: "Мин", stroke: C.min, width: 0, paths: () => null, points: { show: false }, value: moneyVal }
			: { label: "Мин", stroke: C.min, width: 2, fill: sparse ? undefined : gradFill, spanGaps: true, value: moneyVal, points: { show: sparse, size: 7, fill: C.min, stroke: C.min }, ...(o.pointsOnly ? { paths: () => null } : {}) },
		{ label: "Прогноз", stroke: C.fc, width: 1.5, dash: [5, 4], spanGaps: true, value: moneyVal, points: { show: false } },
		{ label: "Прогноз −", stroke: "transparent", points: { show: false }, spanGaps: true, value: moneyVal },
		{ label: "Прогноз +", stroke: "transparent", points: { show: false }, spanGaps: true, value: moneyVal },
		{ label: "Мой скан", stroke: C.own, width: 0, paths: () => null, points: { show: false }, value: moneyVal },
		{ label: "Свеча H", stroke: "transparent", paths: () => null, points: { show: false } },
		{ label: "Свеча L", stroke: "transparent", paths: () => null, points: { show: false } },
	];
	const priceData = [d.xs, d.p25, d.p75, d.median, d.min, d.fcMid, d.fcLo, d.fcHi, d.own, d.cHi, d.cLo];
	// В режиме свечей цену «min» показываем только свечами (точки дней <4 снимков рисуем отдельно).
	if (candleMode) priceData[4] = d.min.map(() => null);

	const drawHook = (u) => {
		const ctx = u.ctx;
		const { left, top, width, height } = u.bbox;
		ctx.save();
		// Зона прогноза и линия «сейчас».
		if (B.fcOn) {
			const xn = Math.round(u.valToPos(B.to, "x", true));
			if (xn > left && xn < left + width) {
				ctx.fillStyle = C.fc + "0c";
				ctx.fillRect(xn, top, left + width - xn, height);
				ctx.strokeStyle = C.now;
				ctx.setLineDash([2 * r, 3 * r]);
				ctx.lineWidth = r;
				ctx.beginPath(); ctx.moveTo(xn + 0.5, top); ctx.lineTo(xn + 0.5, top + height); ctx.stroke();
				ctx.setLineDash([]);
				ctx.font = `${Math.round(10 * r)}px ${css("--font-ui")}`;
				ctx.fillStyle = C.axis;
				ctx.textBaseline = "bottom";
				ctx.textAlign = "right";
				ctx.fillText("сейчас", xn - 5 * r, top + height - 5 * r);
				ctx.textAlign = "left";
				ctx.fillStyle = C.fc;
				ctx.fillText(o.lowConfidence ? "модель · низкая уверенность" : "модель · полоса 80%", xn + 6 * r, top + height - 5 * r);
			}
		}
		ctx.beginPath();
		ctx.rect(left, top, width, height);
		ctx.clip();
		// Уровни 30д.
		for (const l of levels) {
			const y = Math.round(u.valToPos(l.v, "y", true)) + 0.5;
			if (y < top || y > top + height) continue;
			ctx.strokeStyle = l.c;
			ctx.globalAlpha = 0.75;
			ctx.lineWidth = l.w * r;
			ctx.setLineDash(l.dash.map(x => x * r));
			ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
			ctx.globalAlpha = 1;
		}
		ctx.setLineDash([]);
		// Свечи.
		if (candleMode) {
			const xsPx = [...B.candleAt.keys()].map(i => u.valToPos(d.xs[i], "x", true));
			const gap = xsPx.length > 1 ? Math.min(...xsPx.slice(1).map((x, k) => x - xsPx[k])) : width / 6;
			const bw = Math.max(3 * r, Math.min(18 * r, gap * 0.62));
			for (const [i, c] of B.candleAt) {
				const x = u.valToPos(d.xs[i], "x", true);
				if (!c.ok) {
					ctx.fillStyle = C.axis;
					ctx.beginPath(); ctx.arc(x, u.valToPos(c.c, "y", true), 2.5 * r, 0, Math.PI * 2); ctx.fill();
					continue;
				}
				const col = c.c >= c.o ? C.up : C.down;
				const yo = u.valToPos(c.o, "y", true), yc = u.valToPos(c.c, "y", true);
				ctx.strokeStyle = col;
				ctx.lineWidth = r;
				ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, u.valToPos(c.h, "y", true)); ctx.lineTo(Math.round(x) + 0.5, u.valToPos(c.l, "y", true)); ctx.stroke();
				ctx.fillStyle = col;
				const yTop = Math.min(yo, yc), hBody = Math.max(r, Math.abs(yc - yo));
				ctx.fillRect(Math.round(x - bw / 2), yTop, Math.round(bw), hBody);
			}
		}
		// Свои сканы: ромбы.
		if (o.own) {
			for (let i = 0; i < d.xs.length; i++) {
				if (d.own[i] == null) continue;
				const x = u.valToPos(d.xs[i], "x", true), y = u.valToPos(d.own[i], "y", true), s = 5 * r;
				ctx.fillStyle = C.bg;
				ctx.strokeStyle = C.own;
				ctx.lineWidth = 1.5 * r;
				ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath();
				ctx.fill(); ctx.stroke();
			}
		}
		ctx.restore();
		// Метки уровней и текущей цены на правой оси.
		const ys = u.scales.y;
		for (const l of levels) {
			if (l.v < ys.min || l.v > ys.max) {
				if (!l.edge) continue;
				const above = l.v > ys.max;
				axisTag(ctx, u, above ? top + 9 * r : top + height - 9 * r, `${l.label} ${above ? "↑" : "↓"} ${moneyText(l.v, true)}`, C.line, l.c);
				continue;
			}
			axisTag(ctx, u, u.valToPos(l.v, "y", true), `${l.label} ${moneyText(l.v, true)}`, C.line, l.c);
		}
		if (isNum(latest.min) && latest.min >= ys.min && latest.min <= ys.max)
			axisTag(ctx, u, u.valToPos(latest.min, "y", true), moneyText(latest.min, true), C.min, "#14110a");
	};

	// Легенда и метки курсора.
	const seriesAt = i => {
		const v = k => (i == null ? null : d[k][i]);
		return { t: i == null ? null : d.xs[i], min: v("min"), median: v("median"), p25: v("p25"), p75: v("p75"), qty: v("qty"), auc: v("auc"), fc: v("fcMid"), fcLo: v("fcLo"), fcHi: v("fcHi"), own: v("own"), candle: i == null ? null : B.candleAt.get(i) };
	};
	const lastIdx = () => { for (let i = d.xs.length - 1; i >= 0; i--) if (d.min[i] != null || d.median[i] != null) return i; return null; };
	const legendItem = (color, label, value, dash) => `<span class="lg"><span class="sw${dash ? " dash" : ""}" style="${dash ? "border-color" : "background"}:${color}"></span>${label} <b>${value}</b></span>`;
	const updateLegend = (i, live) => {
		const s = seriesAt(i ?? lastIdx());
		let h = `<span class="lg-t">${s.t ? (live ? fmtDate(s.t) : "последнее · " + fmtDate(s.t)) : "нет данных"}</span>`;
		if (s.candle && s.candle.ok) h += `<span class="lg">O <b>${money(s.candle.o)}</b></span><span class="lg">H <b>${money(s.candle.h)}</b></span><span class="lg">L <b>${money(s.candle.l)}</b></span><span class="lg">C <b>${money(s.candle.c)}</b></span><span class="lg dim">${s.candle.n} снимков</span>`;
		else if (s.candle) h += `<span class="lg">Мин <b>${money(s.candle.c)}</b></span><span class="lg dim">${s.candle.n} снимк. — мало для свечи</span>`;
		else if (s.fc != null && s.min == null) h += legendItem(C.fc, "Прогноз", money(s.fc), true) + `<span class="lg dim">80%: ${moneyText(s.fcLo, true)} – ${moneyText(s.fcHi, true)}</span>`;
		else h += legendItem(C.min, "Мин", money(s.min));
		if (s.median != null) h += legendItem(C.median, "Медиана", money(s.median));
		if (o.band && s.p25 != null) h += `<span class="lg"><span class="sw band" style="background:${C.band}"></span>p25–p75 <b>${moneyText(s.p25, true)} – ${moneyText(s.p75, true)}</b></span>`;
		if (s.own != null) h += legendItem(C.own, "Мой скан", money(s.own));
		if (s.qty != null) h += `<span class="lg dim">шт <b>${num(s.qty)}</b></span>`;
		legend.innerHTML = h;
	};

	let volU = null;
	const price = new uPlot({
		width: sz.w, height: sz.mh,
		padding: [30, 0, 0, 8],
		legend: { show: false },
		cursor: cursorBase,
		select: { show: true },
		scales: {
			x: { time: true, range: xRangeFn },
			y: o.log ? { distr: 3, range: yRange } : { range: yRange },
		},
		axes: [
			{ show: true, size: 0, font: `11px ${css("--font-ui")}`, labelFont: `11px ${css("--font-ui")}`, stroke: "transparent", grid: { stroke: C.grid, width: 1 }, ticks: { show: false }, values: () => [] },
			{
				side: 1, size: 84, gap: 6, stroke: C.axis, font: `11px ${css("--font-num")}`, labelFont: `11px ${css("--font-ui")}`,
				grid: { stroke: C.grid, width: 1 }, ticks: { show: false },
				values: (u, vals) => vals.map(v => moneyText(v, true)),
			},
		],
		series: priceSeries,
		bands: o.band ? [{ series: [2, 1], fill: C.band }] : [],
		hooks: {
			draw: [drawHook],
			setCursor: [u => {
				const i = u.cursor.idx;
				updateLegend(i, i != null);
				const { left, top } = u.cursor;
				if (left == null || left < 0) { xtag.style.display = ytag.style.display = "none"; return; }
				const ov = u.over.getBoundingClientRect(), rb = main.getBoundingClientRect();
				const v = u.posToVal(top, "y");
				ytag.style.display = top >= 0 ? "block" : "none";
				ytag.textContent = moneyText(v, true);
				ytag.style.top = (ov.top - rb.top + top) + "px";
				ytag.style.left = (ov.left - rb.left + ov.width + 1) + "px";
				const t = u.posToVal(left, "x");
				xtag.style.display = "block";
				xtag.textContent = fmtDate(t);
				xtag.style.left = (ov.left - rb.left + left) + "px";
				xtag.style.top = (ov.top - rb.top + ov.height) + "px";
			}],
			setScale: [(u, key) => {
				if (key !== "x" || syncing || !volU) return;
				syncing = true;
				volU.setScale("x", { min: u.scales.x.min, max: u.scales.x.max });
				syncing = false;
			}],
		},
	}, priceData, main);
	main.addEventListener("mouseleave", () => { xtag.style.display = ytag.style.display = "none"; updateLegend(null, false); });

	const hasAuc = d.auc.some(v => v != null);
	volU = new uPlot({
		width: sz.w, height: sz.vh,
		padding: [6, 0, 0, 8],
		legend: { show: false },
		cursor: { ...cursorBase, points: { show: false }, y: false },
		scales: { x: { time: true, range: xRangeFn }, q: { range: (u, mn, mx) => [0, (mx || 1) * 1.1] }, a: { range: (u, mn, mx) => [0, (mx || 1) * 1.15] } },
		axes: [
			{
				stroke: C.axis, font: `11px ${css("--font-ui")}`, labelFont: `11px ${css("--font-ui")}`, size: 22, gap: 4, grid: { show: false }, ticks: { show: true, stroke: C.grid, size: 4 },
				values: (u, vals, space, incr) => vals.map(v => fmtAxisTime(v, incr)),
			},
			{ scale: "q", side: 1, size: 84, gap: 6, stroke: C.axis, font: `11px ${css("--font-num")}`, labelFont: `11px ${css("--font-ui")}`, grid: { stroke: C.grid, width: 1 }, ticks: { show: false }, values: (u, vals) => vals.map(v => compact(v)), splits: (u, ai, mn, mx) => [0, mx / 2] },
		],
		series: [
			{},
			{ label: "Количество", scale: "q", stroke: C.qty, fill: C.qty, width: 0, paths: uPlot.paths.bars({ size: [0.7, 14 * r], align: 0 }), points: { show: false } },
			{ label: "Аукционы", scale: "a", stroke: C.auc, width: 1.25, spanGaps: true, show: hasAuc, points: { show: false } },
		],
		hooks: {
			setScale: [(u, key) => {
				if (key !== "x" || syncing) return;
				syncing = true;
				price.setScale("x", { min: u.scales.x.min, max: u.scales.x.max });
				syncing = false;
			}],
		},
	}, [d.xs, d.qty, d.auc], vol);

	updateLegend(null, false);

	const ro = new ResizeObserver(debounce(() => {
		const s = sizeOf();
		price.setSize({ width: s.w, height: s.mh });
		volU.setSize({ width: s.w, height: s.vh });
	}, 60));
	ro.observe(box);
	return {
		destroy() { ro.disconnect(); price.destroy(); volU.destroy(); },
		reset() { resetX(price); },
	};
}

// Мини-график для экрана «Обзор рынка».
function renderAreaChart(box, xs, ys, opts = {}) {
	const C = chartColors();
	box.innerHTML = "";
	const w = Math.max(240, box.clientWidth), h = opts.height || Math.max(140, box.clientHeight);
	const color = opts.color || C.min;
	const u = new uPlot({
		width: w, height: h, padding: [10, 0, 0, 6],
		legend: { show: false },
		cursor: { points: { size: 6, fill: C.bg, width: 2 }, drag: { x: false, y: false } },
		scales: { x: { time: true }, y: { range: (u, mn, mx) => [Math.max(0, mn - (mx - mn) * 0.15), mx + (mx - mn) * 0.1 || 1] } },
		axes: [
			{ stroke: C.axis, font: `11px ${css("--font-ui")}`, labelFont: `11px ${css("--font-ui")}`, size: 24, grid: { show: false }, ticks: { show: false }, values: (u, vals, s, incr) => vals.map(v => fmtAxisTime(v, incr)) },
			{ side: 1, size: 70, stroke: C.axis, font: `11px ${css("--font-num")}`, labelFont: `11px ${css("--font-ui")}`, grid: { stroke: C.grid }, ticks: { show: false }, values: (u, vals) => vals.map(v => opts.fmt ? opts.fmt(v) : compact(v)) },
		],
		series: [{}, {
			stroke: color, width: 2,
			fill: (u) => { const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height); g.addColorStop(0, color + "40"); g.addColorStop(1, color + "00"); return g; },
			points: { show: xs.length < 3, size: 6, fill: color },
		}],
		hooks: opts.onCursor ? { setCursor: [u => opts.onCursor(u.cursor.idx)] } : {},
	}, [xs, ys], box);
	const ro = new ResizeObserver(debounce(() => u.setSize({ width: Math.max(240, box.clientWidth), height: opts.height || Math.max(140, box.clientHeight) }), 60));
	ro.observe(box);
	return { destroy() { ro.disconnect(); u.destroy(); } };
}

// Спарклайн 7д на canvas: цвет по направлению.
function drawSpark(canvas, pts) {
	const r = window.devicePixelRatio || 1;
	const w = canvas.clientWidth || 56, h = canvas.clientHeight || 20;
	canvas.width = Math.round(w * r); canvas.height = Math.round(h * r);
	const ctx = canvas.getContext("2d");
	ctx.scale(r, r);
	const vals = (pts || []).filter(p => Array.isArray(p) && isNum(p[1]) && p[1] > 0);
	if (vals.length < 2) {
		ctx.strokeStyle = SPARK_COLORS.flat;
		ctx.setLineDash([2, 3]);
		ctx.beginPath(); ctx.moveTo(2, h / 2); ctx.lineTo(w - 2, h / 2); ctx.stroke();
		return;
	}
	const t0 = vals[0][0], t1 = vals[vals.length - 1][0];
	let mn = Infinity, mx = -Infinity;
	for (const p of vals) { if (p[1] < mn) mn = p[1]; if (p[1] > mx) mx = p[1]; }
	const span = mx - mn || mx * 0.05 || 1;
	const X = t => 1 + ((t - t0) / (t1 - t0 || 1)) * (w - 2);
	const Y = v => h - 2 - ((v - mn) / span) * (h - 4);
	const dir = vals[vals.length - 1][1] >= vals[0][1] ? "up" : "down";
	const col = SPARK_COLORS[dir];
	ctx.beginPath();
	vals.forEach((p, k) => (k ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
	ctx.strokeStyle = col;
	ctx.lineWidth = 1.25;
	ctx.lineJoin = "round";
	ctx.stroke();
	ctx.lineTo(X(t1), h); ctx.lineTo(X(t0), h); ctx.closePath();
	const g = ctx.createLinearGradient(0, 0, 0, h);
	g.addColorStop(0, col + "33"); g.addColorStop(1, col + "00");
	ctx.fillStyle = g;
	ctx.fill();
}
const SPARK_COLORS = { up: "#22c38e", down: "#f0506e", flat: "#3a414d" };
