local addonName, ns = ...

-- Очередь покупок за кнопкой. Игра разрешает одну покупку на одно реальное нажатие,
-- поэтому кнопка при каждом клике делает ровно один шаг: покупает следующий найденный лот,
-- подтверждает ресурс или запускает поиск следующего предмета из списка сделок.
local Buyer = {}
ns.Buyer = Buyer

local SEARCH_TIMEOUT = 5
local SEARCH_INTERVAL = 0.7 -- поиск ограничен 100 запросами в минуту
local QUOTE_TOLERANCE = 1.01

local PRICE_SORT = { { sortOrder = Enum.AuctionHouseSortOrder.Price, reverseSort = false } }
local CONFIRM_TIMEOUT = 10

Buyer.deals = {}
Buyer.nextDeal = 1
Buyer.ready = {}
Buyer.bought = {}
Buyer.spent = 0

function Buyer:Reset(deals)
	self.deals = deals or {}
	self.nextDeal = 1
	self.ready = {}
	self.bought = {}
	self.searching = nil
	self.pending = nil
	self:Prefetch()
end

local function maxAffordable(unit)
	local cap = math.min(ns.SpendableCopper(), ns.Config.MAX_SPEND_PER_PURCHASE_GOLD * 10000)
	return math.floor(cap / unit)
end

local function remainingFor(deal)
	return deal.maxQty - (Buyer.bought[deal.itemID] or 0)
end

-- Запускает поиск следующего предмета, если готовых покупок нет и мы ничего не ждём.
function Buyer:Prefetch()
	if not ns.ahOpen or self.searching or #self.ready > 0 then
		return
	end
	local deal = self.deals[self.nextDeal]
	if not deal then
		ns.UI:Refresh()
		return
	end
	self.nextDeal = self.nextDeal + 1
	self.searching = deal
	local token = {}
	self.searchToken = token
	C_AuctionHouse.SendSearchQuery(C_AuctionHouse.MakeItemKey(deal.itemID), PRICE_SORT, false)
	C_Timer.After(SEARCH_TIMEOUT, function()
		if self.searchToken == token and self.searching then
			self:SearchDone()
		end
	end)
	ns.UI:Refresh()
end

function Buyer:SearchDone()
	self.searching = nil
	self.searchToken = nil
	ns.UI:Refresh()
	if #self.ready == 0 then
		C_Timer.After(SEARCH_INTERVAL, function() self:Prefetch() end)
	end
end

ns.On("COMMODITY_SEARCH_RESULTS_UPDATED", function(itemID)
	local deal = Buyer.searching
	if not deal or deal.itemID ~= itemID then
		return
	end
	local qty, total, last = 0, 0, 0
	local want = remainingFor(deal)
	for i = 1, C_AuctionHouse.GetNumCommoditySearchResults(itemID) do
		local r = C_AuctionHouse.GetCommoditySearchResultInfo(itemID, i)
		if not r or r.unitPrice > deal.maxUnit or qty >= want then
			break
		end
		if not r.containsOwnerItem then
			local take = math.min(r.quantity, want - qty)
			qty = qty + take
			total = total + take * r.unitPrice
			last = r.unitPrice
		end
	end
	if qty > 0 then
		table.insert(Buyer.ready, { commodity = true, deal = deal, itemID = itemID, qty = qty, total = total, unitPrice = last })
	end
	Buyer:SearchDone()
end)

ns.On("ITEM_SEARCH_RESULTS_UPDATED", function(itemKey)
	local deal = Buyer.searching
	if not deal or itemKey.itemID ~= deal.itemID then
		return
	end
	local want = remainingFor(deal)
	for i = 1, C_AuctionHouse.GetNumItemSearchResults(itemKey) do
		local r = C_AuctionHouse.GetItemSearchResultInfo(itemKey, i)
		if not r or want <= 0 then
			break
		end
		if r.buyoutAmount and not r.containsOwnerItem then
			if r.buyoutAmount / r.quantity > deal.maxUnit then
				break
			end
			table.insert(Buyer.ready, { deal = deal, auctionID = r.auctionID, qty = r.quantity, total = r.buyoutAmount })
			want = want - r.quantity
		end
	end
	Buyer:SearchDone()
end)

local commodityFinished

local function confirmCommodity()
	local p = Buyer.pending
	p.confirming = true
	C_AuctionHouse.ConfirmCommoditiesPurchase(p.itemID, p.qty)
	C_Timer.After(CONFIRM_TIMEOUT, function()
		if Buyer.pending == p and p.confirming then
			commodityFinished(false)
		end
	end)
end

-- Один шаг по клику. Вызывается только из OnClick кнопки (аппаратное событие).
function Buyer:Step()
	if not ns.ahOpen then
		ns.Print("откройте аукцион")
		return
	end

	local p = self.pending
	if p then
		if p.quoted and not p.confirming then
			confirmCommodity()
		end
		return
	end

	local action = table.remove(self.ready, 1)
	if not action then
		self:Prefetch()
		return
	end

	local unit = action.total / action.qty
	if action.total > ns.SpendableCopper() or action.total > ns.Config.MAX_SPEND_PER_PURCHASE_GOLD * 10000 then
		-- Ресурсы можно взять меньшим количеством, отдельный лот предмета нельзя.
		local qty = action.commodity and maxAffordable(unit) or 0
		if qty <= 0 then
			ns.Print("пропуск %s: не хватает денег сверх резерва", action.deal.name)
			self:Prefetch()
			ns.UI:Refresh()
			return
		end
		action.qty = qty
		action.total = math.floor(unit * qty)
	end

	local itemID = action.deal.itemID
	self.bought[itemID] = (self.bought[itemID] or 0) + action.qty
	if action.commodity then
		self.pending = { itemID = itemID, qty = action.qty, expected = action.total, name = action.deal.name }
		C_AuctionHouse.StartCommoditiesPurchase(itemID, action.qty, action.unitPrice)
	else
		C_AuctionHouse.PlaceBid(action.auctionID, action.total)
		self.spent = self.spent + action.total
	end
	self:Prefetch()
	ns.UI:Refresh()
end

ns.On("COMMODITY_PRICE_UPDATED", function(unitPrice, totalPrice)
	local p = Buyer.pending
	if not p or p.quoted then
		return
	end
	if totalPrice > p.expected * QUOTE_TOLERANCE or totalPrice > ns.SpendableCopper() then
		C_AuctionHouse.CancelCommoditiesPurchase()
		ns.Print("отмена %s: цена выросла до %s", p.name, ns.Money(totalPrice))
		Buyer.bought[p.itemID] = Buyer.bought[p.itemID] - p.qty
		Buyer.pending = nil
		ns.UI:Refresh()
		return
	end
	p.quoted = true
	p.total = totalPrice
	if ns.Config.AUTO_CONFIRM_COMMODITY and not Buyer.confirmBlocked then
		confirmCommodity()
	end
	ns.UI:Refresh()
end)

function commodityFinished(ok)
	local p = Buyer.pending
	if not p then
		return
	end
	if ok then
		Buyer.spent = Buyer.spent + (p.total or p.expected)
	else
		Buyer.bought[p.itemID] = Buyer.bought[p.itemID] - p.qty
		ns.Print("не удалось купить %s", p.name)
	end
	Buyer.pending = nil
	Buyer:Prefetch()
	ns.UI:Refresh()
end

ns.On("COMMODITY_PURCHASE_SUCCEEDED", function() commodityFinished(true) end)
ns.On("COMMODITY_PURCHASE_FAILED", function() commodityFinished(false) end)
ns.On("COMMODITY_PRICE_UNAVAILABLE", function() commodityFinished(false) end)

-- Если игра не даёт подтверждать покупку из события, дальше подтверждаем вторым кликом.
local function onBlocked(blockedAddon, func)
	if blockedAddon == addonName and func and func:find("ConfirmCommoditiesPurchase") then
		Buyer.confirmBlocked = true
		if Buyer.pending then
			Buyer.pending.confirming = false
		end
		ns.Print("автоподтверждение заблокировано игрой, подтверждайте вторым нажатием")
		ns.UI:Refresh()
	end
end
ns.On("ADDON_ACTION_BLOCKED", onBlocked)
ns.On("ADDON_ACTION_FORBIDDEN", onBlocked)

ns.On("AUCTION_HOUSE_CLOSED", function()
	Buyer.searching = nil
	Buyer.pending = nil
	Buyer.ready = {}
end)

-- Текст для большой кнопки.
function Buyer:Label()
	local p = self.pending
	if p then
		if p.quoted and not p.confirming then
			return string.format("Подтвердить: %d x %s за %s", p.qty, p.name, ns.Money(p.total))
		end
		return "Ждём ответ аукциона..."
	end
	local a = self.ready[1]
	if a then
		return string.format("Купить %d x %s за %s", a.qty, a.deal.name, ns.Money(a.total))
	end
	if self.searching then
		return "Ищем: " .. self.searching.name
	end
	if self.deals and self.deals[self.nextDeal] then
		return "Искать следующий"
	end
	return "Сделок нет"
end
