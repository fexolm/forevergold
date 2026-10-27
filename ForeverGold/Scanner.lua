local _, ns = ...

-- Полный скан аукциона через C_AuctionHouse.ReplicateItems.
-- Игра разрешает его примерно раз в 15 минут, поэтому между сканами покупаем по точечным поискам.
local Scanner = {}
ns.Scanner = Scanner

local REPLICATE_COOLDOWN = 15 * 60
local CHUNK = 2000
local LOW_SHARE = 0.15

Scanner.running = false
Scanner.last = nil -- [itemID] = { name, min, qty }

function Scanner:CooldownLeft()
	local last = ForeverGoldDB.lastReplicate or 0
	return math.max(0, last + REPLICATE_COOLDOWN - time())
end

function Scanner:Start()
	if not ns.ahOpen then
		ns.Print("откройте аукцион")
		return
	end
	if self.running then
		return
	end
	local left = self:CooldownLeft()
	if left > 0 then
		ns.Print("полный скан будет доступен через %d мин", math.ceil(left / 60))
		return
	end
	self.running = true
	self.waiting = true
	ForeverGoldDB.lastReplicate = time()
	ns.UI:SetStatus("Скан: ждём данные аукциона...")
	C_AuctionHouse.ReplicateItems()
end

-- Средняя цена самых дешёвых LOW_SHARE штук: устойчивее к одиночному лоту, чем минимум.
local function lowAverage(lots, total)
	table.sort(lots, function(a, b) return a[1] < b[1] end)
	local want = math.max(1, math.floor(total * LOW_SHARE))
	local sum, got = 0, 0
	for _, lot in ipairs(lots) do
		local take = math.min(lot[2], want - got)
		sum = sum + lot[1] * take
		got = got + take
		if got >= want then
			break
		end
	end
	return sum / got
end

function Scanner:Process()
	local total = C_AuctionHouse.GetNumReplicateItems()
	local byItem = {}
	local index = 0

	local function finish()
		local result = {}
		for itemID, agg in pairs(byItem) do
			local low = lowAverage(agg.lots, agg.qty)
			ns.PriceDB:RecordScan(itemID, agg.name, agg.min, low, agg.qty)
			result[itemID] = { name = agg.name, min = agg.min, qty = agg.qty }
		end
		self.last = result
		self.running = false
		ns.Print("скан готов: %d лотов", total)
		ns.Deals:Rebuild()
	end

	local function step()
		if not ns.ahOpen then
			self.running = false
			ns.UI:SetStatus("Скан прерван: аукцион закрыт")
			return
		end
		local stop = math.min(index + CHUNK, total)
		for i = index, stop - 1 do
			local name, _, count, _, _, _, _, _, _, buyout, _, _, _, _, _, _, itemID = C_AuctionHouse.GetReplicateItemInfo(i)
			if itemID and buyout and buyout > 0 and count and count > 0 then
				local agg = byItem[itemID]
				if not agg then
					agg = { name = name, min = math.huge, qty = 0, lots = {} }
					byItem[itemID] = agg
				end
				local unit = buyout / count
				agg.name = agg.name or name
				agg.min = math.min(agg.min, unit)
				agg.qty = agg.qty + count
				table.insert(agg.lots, { unit, count })
			end
		end
		index = stop
		ns.UI:SetStatus(string.format("Скан: %d / %d", index, total))
		if index < total then
			C_Timer.After(0, step)
		else
			finish()
		end
	end

	step()
end

-- Событие приходит несколько раз, пока догружаются данные: ждём секунду тишины и обрабатываем.
ns.On("REPLICATE_ITEM_LIST_UPDATE", function()
	if not Scanner.waiting then
		return
	end
	if Scanner.timer then
		Scanner.timer:Cancel()
	end
	Scanner.timer = C_Timer.NewTimer(1, function()
		Scanner.waiting = false
		Scanner.timer = nil
		Scanner:Process()
	end)
end)

ns.On("AUCTION_HOUSE_CLOSED", function()
	if Scanner.waiting then
		Scanner.waiting = false
		Scanner.running = false
	end
end)
