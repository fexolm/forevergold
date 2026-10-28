local _, ns = ...

-- Рыночные цены из двух источников:
--  1. Таблица AHledger (AHLedgerPrices.lua, файла нет в git), которую пишет tools/ahledger-sync.ps1.
--  2. Свои сканы: по каждому предмету храним дневные минимумы за OWN_HISTORY_DAYS дней.
-- Все цены в меди за штуку.
local PriceDB = {}
ns.PriceDB = PriceDB

-- Поля строки AHledger по порядку.
local AHL_FIELDS = { "itemID", "median", "minBuyout", "quantity", "median7d", "median30d", "low30d", "high30d", "sales10" }

local function splitKeepEmpty(line, sep)
	local out, pos = {}, 1
	while true do
		local s, e = line:find(sep, pos, true)
		if not s then
			table.insert(out, line:sub(pos))
			return out
		end
		table.insert(out, line:sub(pos, s - 1))
		pos = e + 1
	end
end

-- Разбирает текст pricetable. Возвращает items, время и рынок.
function PriceDB.ParseAHLedger(raw)
	local items, count, time, market = {}, 0, nil, nil
	for line in raw:gmatch("[^\r\n]+") do
		if line:sub(1, 4) == "AHL1" then
			local parts = splitKeepEmpty(line, "|")
			market, time = parts[2], tonumber(parts[3])
		else
			local sep = line:match("[|,;\t]")
			if sep then
				local parts = splitKeepEmpty(line, sep)
				local itemID = tonumber(parts[1])
				if itemID then
					local row = {}
					for i = 2, #AHL_FIELDS do
						row[AHL_FIELDS[i]] = tonumber(parts[i])
					end
					items[itemID] = row
					count = count + 1
				end
			end
		end
	end
	return items, count, time, market
end

function PriceDB:Init()
	self.ahledger = {}
	self.ahledgerCount = 0
	if ForeverGold_AHLedgerRaw then
		self.ahledger, self.ahledgerCount, self.ahledgerTime, self.ahledgerMarket = PriceDB.ParseAHLedger(ForeverGold_AHLedgerRaw)
		ForeverGold_AHLedgerRaw = nil
	end
end

local function today()
	return math.floor(time() / 86400)
end

local function median(list)
	if #list == 0 then
		return nil
	end
	table.sort(list)
	local mid = math.floor((#list + 1) / 2)
	if #list % 2 == 1 then
		return list[mid]
	end
	return (list[mid] + list[mid + 1]) / 2
end

-- Записывает итог скана по предмету: lowPrice = средняя цена дешёвых 15% лотов.
function PriceDB:RecordScan(itemID, name, minPrice, lowPrice, quantity)
	local item = ForeverGoldDB.items[itemID]
	if not item then
		item = { days = {} }
		ForeverGoldDB.items[itemID] = item
	end
	item.name = name or item.name
	item.min = minPrice
	item.qty = quantity
	item.seen = time()

	local d = today()
	local prevLow = item.days[d]
	item.days[d] = prevLow and math.min(prevLow, lowPrice) or lowPrice
	for day in pairs(item.days) do
		if day <= d - ns.Config.OWN_HISTORY_DAYS then
			item.days[day] = nil
		end
	end
end

function PriceDB:OwnMarket(itemID)
	local item = ForeverGoldDB.items[itemID]
	if not item then
		return nil
	end
	local list = {}
	for _, low in pairs(item.days) do
		table.insert(list, low)
	end
	-- Один день истории ничего не говорит о рынке.
	if #list < 2 then
		return nil
	end
	return median(list)
end

-- Рыночная цена: AHledger (7 дней, потом 30, потом текущая медиана), иначе свои сканы.
function PriceDB:Market(itemID)
	local row = self.ahledger[itemID]
	if row then
		local price = row.median7d or row.median30d or row.median
		if price then
			return price
		end
	end
	return self:OwnMarket(itemID)
end

-- Продаж в день или nil, если неизвестно.
function PriceDB:SalesPerDay(itemID)
	local row = self.ahledger[itemID]
	if row and row.sales10 then
		return row.sales10 / 10
	end
	return nil
end

function PriceDB:Name(itemID)
	local item = ForeverGoldDB.items[itemID]
	return (item and item.name) or C_Item.GetItemNameByID(itemID) or ("item:" .. itemID)
end
