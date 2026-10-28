-- Прогон логики аддона вне игры на заглушках WoW API: lua5.1 tests/run.lua
local now = 1800000000
local money = 5000 * 10000
local events, timers = {}, {}
local calls = {}

local function noop() end
local fontString = setmetatable({}, { __index = function() return noop end })
local function newFrame()
	local f = setmetatable({ shown = false }, { __index = function() return noop end })
	f.TitleText = fontString
	f.CreateFontString = function() return fontString end
	f.RegisterEvent = function(_, e) events[e] = f end
	f.SetScript = function(self, k, fn) self[k] = fn end
	f.Show = function(self) self.shown = true end
	f.Hide = function(self) self.shown = false end
	f.IsShown = function(self) return self.shown end
	f.SetShown = function(self, v) self.shown = v end
	f.SetText = function(self, t) self.text = t end
	return f
end

CreateFrame = function(_, name) local f = newFrame(); if name then _G[name] = f end; return f end
time = function() return now end
date = os.date
GetMoney = function() return money end
C_Timer = {
	After = function(_, fn) table.insert(timers, fn) end,
	NewTimer = function(_, fn) local t = { Cancel = function(self) self.cancelled = true end }; table.insert(timers, function() if not t.cancelled then fn() end end); return t end,
	NewTicker = function() end,
}
-- Выполняет отложенные вызовы по одному, пока не выполнится условие (или пока очередь не опустеет).
local function runTimers(untilFn)
	while #timers > 0 and not (untilFn and untilFn()) do table.remove(timers, 1)() end
end
Enum = { ItemClass = { Weapon = 2, Armor = 4 }, AuctionHouseSortOrder = { Price = 0 } }
SlashCmdList = {}

local replicate = {}
local commodityResults = { [2447] = { { unitPrice = 100, quantity = 50 }, { unitPrice = 120, quantity = 100 }, { unitPrice = 900, quantity = 10 } } }
itemResults = {}
C_AuctionHouse = {
	GetNumItemSearchResults = function() return #itemResults end,
	GetItemSearchResultInfo = function(_, i) local r = itemResults[i]; return { auctionID = r.auctionID, quantity = r.quantity, buyoutAmount = r.buyoutAmount, containsOwnerItem = false } end,
	ReplicateItems = function() calls.replicate = true end,
	GetNumReplicateItems = function() return #replicate end,
	GetReplicateItemInfo = function(i) local r = replicate[i + 1]; return r.name, nil, r.count, nil, nil, nil, nil, nil, nil, r.buyout, nil, nil, nil, nil, nil, nil, r.itemID end,
	MakeItemKey = function(id) return { itemID = id } end,
	SendSearchQuery = function(key) calls.search = key.itemID end,
	GetNumCommoditySearchResults = function(id) return #(commodityResults[id] or {}) end,
	GetCommoditySearchResultInfo = function(id, i) local r = commodityResults[id][i]; return { unitPrice = r.unitPrice, quantity = r.quantity, containsOwnerItem = false } end,
	StartCommoditiesPurchase = function(id, qty) calls.start = { id, qty } end,
	ConfirmCommoditiesPurchase = function(id, qty) calls.confirm = { id, qty } end,
	CancelCommoditiesPurchase = function() calls.cancel = true end,
	PlaceBid = function(id, amount) calls.bid = { id, amount } end,
}
C_Item = {
	GetItemInfoInstant = function(id) return id, nil, nil, nil, nil, 7 end,
	GetItemInfo = function(id) if id == 3000 then return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, 50000 end return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, 1 end,
	RequestLoadItemDataByID = noop,
	GetItemNameByID = function() return nil end,
}

local function fire(e, ...)
	local f = events[e]
	if f then f.OnEvent(f, e, ...) end
end

ForeverGold_AHLedgerRaw = "AHL1|forever/normal/alliance/eu|" .. (now - 600) .. "|2\n2447:300:250:1000:300:310:200:400:500\n3000::::::::\n"

local ns = {}
for _, file in ipairs({ "Config", "Core", "PriceDB", "Scanner", "Deals", "Buyer", "UI" }) do
	assert(loadfile("ForeverGold/" .. file .. ".lua"))("ForeverGold", ns)
end

local function check(cond, msg) if not cond then error("FAIL: " .. msg, 2) end print("ok  " .. msg) end

fire("ADDON_LOADED", "ForeverGold")
check(ns.PriceDB.ahledgerCount == 2, "AHledger: разобрано 2 строки")
check(ns.PriceDB:Market(2447) == 300, "рынок берётся из median7d")
check(ns.PriceDB:SalesPerDay(2447) == 50, "продажи = sales10 / 10")
check(ns.PriceDB:Market(3000) == nil, "пустые поля = нет цены")

replicate = {
	{ name = "Peacebloom", count = 50, buyout = 5000, itemID = 2447 },
	{ name = "Peacebloom", count = 100, buyout = 12000, itemID = 2447 },
	{ name = "Junk", count = 1, buyout = 100, itemID = 3000 },
	{ name = "Normal", count = 1, buyout = 100, itemID = 4000 },
}
fire("AUCTION_HOUSE_SHOW")
ns.Scanner:Start()
check(calls.replicate, "скан вызывает ReplicateItems")
fire("REPLICATE_ITEM_LIST_UPDATE")
runTimers(function() return ns.Scanner.last ~= nil end)
check(ns.Scanner.last[2447].min == 100 and ns.Scanner.last[2447].qty == 150, "скан: минимум и количество")
local exp = ForeverGoldDB.export
check(exp and #exp.scans == 1 and exp.scans[1].items[2447] == "100,150;100:50;120:100", "экспорт стакана: min,qty и уровни цен")
check(exp.names[2447] == "Peacebloom", "экспорт названий")
check(#ns.Deals.list == 2, "найдены 2 сделки: рынок и вендор, обычный лот пропущен")
local herb, junk
for _, d in ipairs(ns.Deals.list) do
	if d.itemID == 2447 then herb = d elseif d.itemID == 3000 then junk = d end
end
check(herb and herb.kind == "рынок", "травы - сделка по рынку")
check(junk and junk.kind == "вендор", "хлам дешевле вендора - сделка вендор")
check(ns.Deals.list[1] == junk, "сортировка по ожидаемой прибыли")
check(calls.search == 3000, "после скана сразу ищем первую сделку")

-- Хлам не нашёлся (уже купили): по таймауту переходим к травам.
runTimers(function() return calls.search == 2447 end)
check(calls.search == 2447, "по таймауту поиска переходим к следующей сделке")
fire("COMMODITY_SEARCH_RESULTS_UPDATED", 2447)
-- maxUnit = 300 * 0.6 = 180, продаж 50/день * 3 дня = 150 штук.
local a = ns.Buyer.ready[1]
check(a and a.qty == 150 and a.total == 50 * 100 + 100 * 120, "берём 150 штук до 180 меди, дорогой лот не трогаем")

ns.Buyer:Step()
check(calls.start and calls.start[2] == 150, "клик 1 запускает покупку ресурса")
fire("COMMODITY_PRICE_UPDATED", 110, 17000)
check(calls.confirm and calls.confirm[2] == 150, "цена в пределах - автоподтверждение")
fire("COMMODITY_PURCHASE_SUCCEEDED")
check(ns.Buyer.pending == nil and ns.Buyer.spent == 17000, "покупка учтена")

-- Резерв: оставляем денег меньше, чем стоит покупка.
calls = {}
ns.Buyer.ready = { { commodity = true, deal = herb, itemID = 2447, qty = 100, total = 10000, unitPrice = 100 } }
money = ns.ReserveCopper() + 5000
ns.Buyer:Step()
check(calls.start and calls.start[2] == 50, "резерв: покупаем только на то, что сверх резерва")
fire("COMMODITY_PRICE_UPDATED", 100, 9000)
check(calls.cancel, "цена выше доступного - отмена")

calls = {}
money = ns.ReserveCopper() + 50
ns.Buyer.pending = nil
ns.Buyer.ready = { { deal = junk, auctionID = 7, qty = 1, total = 100 } }
ns.Buyer:Step()
check(not calls.bid, "резерв: лот дороже доступного не покупаем")

money = ns.ReserveCopper() + 1000
ns.Buyer.ready = { { deal = junk, auctionID = 7, qty = 1, total = 100 } }
ns.Buyer:Step()
check(calls.bid and calls.bid[1] == 7, "обычный лот покупается через PlaceBid")
local spentBefore = ns.Buyer.spent
check(ns.Buyer.spent == spentBefore and ns.Buyer.placed[7] == 100, "до подтверждения покупка не считается потраченной")
fire("AUCTION_HOUSE_PURCHASE_COMPLETED", 7)
check(ns.Buyer.spent == spentBefore + 100, "после AUCTION_HOUSE_PURCHASE_COMPLETED покупка учтена")

-- Стопка больше оставшегося лимита не попадает в очередь.
itemResults = { { auctionID = 1, quantity = 20, buyoutAmount = 2000 }, { auctionID = 2, quantity = 5, buyoutAmount = 600 } }
ns.Buyer.ready = {}
ns.Buyer.bought = {}
ns.Buyer.searching = { itemID = 5000, maxQty = 10, maxUnit = 150, name = "Gear" }
fire("ITEM_SEARCH_RESULTS_UPDATED", { itemID = 5000 })
check(#ns.Buyer.ready == 1 and ns.Buyer.ready[1].auctionID == 2, "стопка 20 при лимите 10 пропущена, стопка 5 взята")

print("все проверки пройдены")
