local _, ns = ...

-- Ищет предметы, у которых после скана есть лоты дешевле рынка или дешевле цены продажи вендору.
local Deals = {}
ns.Deals = Deals

Deals.list = {}

-- Без данных AHledger ликвидность неизвестна: берём понемногу.
local UNKNOWN_LIQUIDITY_MAX_QTY = 20

local function isEquipment(itemID)
	local classID = select(6, C_Item.GetItemInfoInstant(itemID))
	return classID == Enum.ItemClass.Weapon or classID == Enum.ItemClass.Armor
end

local function vendorPrice(itemID)
	local sellPrice = select(11, C_Item.GetItemInfo(itemID))
	if sellPrice == nil then
		C_Item.RequestLoadItemDataByID(itemID)
	end
	return sellPrice or 0
end

-- Возвращает сделку или nil. maxUnit: дороже этой цены за штуку не покупаем.
function Deals.Evaluate(itemID, minPrice, available)
	local cfg = ns.Config
	local deal

	local vendor = vendorPrice(itemID)
	if vendor > 0 and minPrice < vendor then
		deal = { kind = "вендор", target = vendor, maxUnit = vendor - 1, maxQty = math.huge }
	end

	if cfg.SKIP_EQUIPMENT and isEquipment(itemID) then
		return deal
	end

	local market = ns.PriceDB:Market(itemID)
	if market and minPrice <= market * cfg.DEAL_MAX_PRICE_RATIO then
		local sales = ns.PriceDB:SalesPerDay(itemID)
		local maxQty
		if sales then
			if sales >= cfg.MIN_SALES_PER_DAY then
				maxQty = math.floor(sales * cfg.MAX_DAYS_OF_SUPPLY)
			end
		elseif ns.PriceDB.ahledgerCount == 0 then
			maxQty = UNKNOWN_LIQUIDITY_MAX_QTY
		end
		local resale = market * (1 - cfg.AH_CUT)
		if maxQty and maxQty > 0 and (not deal or resale > deal.target) then
			deal = { kind = "рынок", target = resale, maxUnit = market * cfg.DEAL_MAX_PRICE_RATIO, maxQty = maxQty }
		end
	end

	if not deal then
		return nil
	end
	deal.itemID = itemID
	deal.minPrice = minPrice
	deal.unitProfit = deal.target - minPrice
	deal.estProfit = deal.unitProfit * math.min(deal.maxQty, available)
	if deal.estProfit < cfg.MIN_PROFIT_GOLD * 10000 then
		return nil
	end
	return deal
end

function Deals:Rebuild()
	local list = {}
	for itemID, agg in pairs(ns.Scanner.last or {}) do
		local deal = Deals.Evaluate(itemID, agg.min, agg.qty)
		if deal then
			deal.name = agg.name or ns.PriceDB:Name(itemID)
			table.insert(list, deal)
		end
	end
	table.sort(list, function(a, b) return a.estProfit > b.estProfit end)
	self.list = list
	ns.Buyer:Reset(list)
	ns.UI:Refresh()
end
