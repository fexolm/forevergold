"use strict";
// ForeverGold terminal: общие помощники (формат денег, времени, DOM, API).
// Классические скрипты без модулей: функции общие для util.js, chart.js, tabs.js, app.js.

const COPPER_PER_GOLD = 10000;
const CUT = 0.95; // аукцион забирает 5%

// ---------- API ----------

async function api(path, opts) {
	const r = await fetch(path, opts);
	if (!r.ok) {
		const err = new Error((await r.text().catch(() => "")) || r.statusText);
		err.status = r.status;
		throw err;
	}
	return r.json();
}

// Ответ документа AHledger вместе с заголовком X-Fetched-At.
async function apiDoc(kind) {
	const r = await fetch("/api/doc/" + kind);
	if (!r.ok) {
		const err = new Error((await r.text().catch(() => "")) || r.statusText);
		err.status = r.status;
		throw err;
	}
	const doc = await r.json();
	return { doc: doc || {}, fetched: Number(r.headers.get("X-Fetched-At")) || 0 };
}

// ---------- DOM ----------

function el(tag, attrs, ...children) {
	const e = document.createElement(tag);
	if (attrs) for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
		else if (k === "html") e.innerHTML = v;
		else if (k === "class") e.className = v;
		else e.setAttribute(k, v === true ? "" : v);
	}
	for (const c of children.flat(Infinity)) {
		if (c === null || c === undefined || c === false || c === "") continue;
		e.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return e;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, c => ESC[c]);
}

function $(sel, root) { return (root || document).querySelector(sel); }

const isNum = v => typeof v === "number" && isFinite(v);

// ---------- Числа и деньги ----------

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

function num(v, digits = 0) {
	if (!isNum(v)) return "—";
	return (digits === 0 ? nf0 : digits === 1 ? nf1 : nf2).format(v);
}

// Компактное число: 1 234 → 1,2к; 2 300 000 → 2,3м
function compact(v) {
	if (!isNum(v)) return "—";
	const a = Math.abs(v);
	if (a >= 1e6) return nf1.format(v / 1e6) + "м";
	if (a >= 1e4) return nf0.format(v / 1e3) + "к";
	if (a >= 1e3) return nf1.format(v / 1e3) + "к";
	return nf0.format(v);
}

// Деньги в HTML: «12з 34с 56м» с цветными буквами. Крупные суммы сокращаются.
// opts.compact: отбросить мелкие единицы, opts.plain: вернуть текст без разметки.
function money(copper, opts = {}) {
	if (!isNum(copper)) return opts.plain ? "—" : '<span class="m na">—</span>';
	const neg = copper < 0;
	let c = Math.round(Math.abs(copper));
	const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), m = c % 100;
	const parts = [];
	const unit = (n, u, cls) => opts.plain ? n + (/к$/.test(n) ? " " : "") + u : `<b>${n}</b><i class="${cls}">${u}</i>`;
	if (g >= 100000) parts.push(unit(nf0.format(g / 1000) + "к", "з", "g"));
	else if (g >= 10000) parts.push(unit(nf1.format(g / 1000) + "к", "з", "g"));
	else if (g > 0) {
		parts.push(unit(nf0.format(g), "з", "g"));
		const drop = opts.compact ? g >= 10 : g >= 1000;
		if (!drop) {
			if (s) parts.push(unit(s, "с", "s"));
			if (m && !opts.compact && g < 100) parts.push(unit(m, "м", "c"));
		}
	} else if (s > 0) {
		parts.push(unit(s, "с", "s"));
		if (m) parts.push(unit(m, "м", "c"));
	} else parts.push(unit(m, "м", "c"));
	const txt = (neg ? "−" : "") + parts.join(opts.plain ? " " : " ");
	return opts.plain ? txt : `<span class="m${neg ? " neg" : ""}">${txt}</span>`;
}

const moneyText = (c, compactMode) => money(c, { plain: true, compact: compactMode });

// Парсит ввод денег: «12з 34с», «12.5» (золото), «3400м», «45с».
function parseMoney(str) {
	if (str === null || str === undefined) return null;
	const s = String(str).trim().toLowerCase().replace(/,/g, ".").replace(/\s+/g, " ");
	if (!s) return null;
	const re = /(-?\d+(?:\.\d+)?)\s*(з|g|с|s|м|c|m)?/g;
	let total = 0, any = false, mt;
	while ((mt = re.exec(s))) {
		any = true;
		const v = parseFloat(mt[1]);
		const u = mt[2] || "з";
		total += u === "з" || u === "g" ? v * 10000 : u === "с" || u === "s" ? v * 100 : v;
	}
	return any ? Math.round(total) : null;
}

// Доли → проценты со знаком: 0.123 → «+12,3%»
function pct(v, digits = 1, signed = true) {
	if (!isNum(v)) return "—";
	const p = v * 100;
	const sign = signed && p > 0.0499 ? "+" : p < -0.0499 ? "−" : "";
	return sign + Math.abs(p).toFixed(digits).replace(".", ",") + "%";
}

function signCls(v, eps = 0.0005) {
	if (!isNum(v) || Math.abs(v) < eps) return "flat";
	return v > 0 ? "up" : "down";
}

// ---------- Время ----------

const nowSec = () => Math.floor(Date.now() / 1000);

// ISO-строки AHledger и unix-секунды демона приводим к секундам.
function toSec(t) {
	if (isNum(t)) return t > 1e12 ? Math.floor(t / 1000) : t;
	if (typeof t === "string" && t) { const ms = Date.parse(t); return isNaN(ms) ? 0 : Math.floor(ms / 1000); }
	return 0;
}

function plural(n, one, few, many) {
	const a = Math.abs(n) % 100, b = a % 10;
	if (a > 10 && a < 20) return many;
	if (b > 1 && b < 5) return few;
	if (b === 1) return one;
	return many;
}

function ago(t) {
	const s = toSec(t);
	if (!s) return "никогда";
	const d = nowSec() - s;
	if (d < 60) return "только что";
	if (d < 3600) return Math.round(d / 60) + " мин назад";
	if (d < 86400 * 2) { const h = Math.round(d / 3600); return h + " ч назад"; }
	const days = Math.round(d / 86400);
	return days + " " + plural(days, "день", "дня", "дней") + " назад";
}

function dur(sec) {
	if (!isNum(sec)) return "—";
	if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + " мин";
	if (sec < 86400 * 2) return nf1.format(sec / 3600) + " ч";
	return nf1.format(sec / 86400) + " дн";
}

const WD_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MON_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function fmtDate(t, withTime = true) {
	const d = new Date(toSec(t) * 1000);
	const base = d.getDate() + " " + MON_SHORT[d.getMonth()];
	return withTime ? base + ", " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") : base;
}

function fmtClock(t) {
	const d = new Date(toSec(t) * 1000);
	return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

// ---------- Предметы ----------

const QUALITY = { POOR: "q0", COMMON: "q1", UNCOMMON: "q2", RARE: "q3", EPIC: "q4", LEGENDARY: "q5" };
const qcls = q => QUALITY[String(q || "").toUpperCase()] || "q1";

// Имя предмета: русское, если демон его знает. Заглушки AHledger «Item 123» не показываем как имя.
function itemName(o) {
	if (!o) return "Неизвестный предмет";
	const n = o.ruName || o.name || "";
	if (!n || /^item[: ]\s*\d+$/i.test(n)) {
		const id = o.itemId ?? o.id;
		return id ? "Предмет #" + id : "Неизвестный предмет";
	}
	return n;
}

// Имя-заглушка: русского/английского названия демон ещё не знает.
function isPlaceholderName(n) {
	return /^(Неизвестный предмет|Предмет #\d+)$/.test(n);
}

function itemIdOf(o) {
	if (!o) return null;
	return o.itemId ?? o.id ?? null;
}

// Иконка: картинка с рамкой цвета качества или буква-заглушка.
function iconHTML(o, size = 22) {
	const name = itemName(o);
	const q = qcls(o && o.quality);
	const letter = esc((name.match(/[\p{L}\d]/u) || ["?"])[0].toUpperCase());
	if (o && o.icon) return `<span class="ico ${q}" style="width:${size}px;height:${size}px"><img src="${esc(o.icon)}" alt="" loading="lazy" onerror="this.remove()"><span class="ico-l">${letter}</span></span>`;
	return `<span class="ico ${q}" style="width:${size}px;height:${size}px"><span class="ico-l">${letter}</span></span>`;
}

function nameHTML(o, extra = "") {
	const unknown = isPlaceholderName(itemName(o));
	return `<span class="nm ${qcls(o && o.quality)}${unknown ? " unk" : ""}">${esc(itemName(o))}</span>${extra}`;
}

// ---------- Статистика ----------

// Интервал Уилсона 95% для доли побед.
function wilson(wins, n, z = 1.96) {
	if (!n) return [0, 1];
	const p = wins / n, z2 = z * z;
	const den = 1 + z2 / n;
	const centre = (p + z2 / (2 * n)) / den;
	const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / den;
	return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function median(arr) {
	const a = arr.filter(isNum).sort((x, y) => x - y);
	if (!a.length) return null;
	const m = a.length >> 1;
	return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---------- Хранилище настроек (только удобства) ----------

const store = {
	get(k, def) { try { const v = localStorage.getItem("fg." + k); return v === null ? def : JSON.parse(v); } catch { return def; } },
	set(k, v) { try { localStorage.setItem("fg." + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

function css(name) {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function debounce(fn, ms) {
	let t;
	return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Пустое состояние / ошибка для панели.
function stateHTML(kind, title, text) {
	const icons = {
		empty: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h10M4 17h7" /></svg>',
		error: '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>',
		closed: '<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>',
		wait: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>',
	};
	return `<div class="state state-${kind}"><div class="state-ic">${icons[kind] || icons.empty}</div><div class="state-t">${esc(title)}</div>${text ? `<div class="state-x">${text}</div>` : ""}</div>`;
}

function skeletonRows(n, cols = 5) {
	let s = '<div class="skel-wrap">';
	for (let i = 0; i < n; i++) {
		s += '<div class="skel-row">';
		for (let c = 0; c < cols; c++) s += `<span class="skel" style="width:${c === 0 ? 40 + ((i * 37) % 30) : 12 + ((i + c) * 13) % 10}%"></span>`;
		s += "</div>";
	}
	return s + "</div>";
}

function marketClosed(doc) {
	return !!(doc && typeof doc.marketStatus === "string" && /not open/i.test(doc.marketStatus));
}
