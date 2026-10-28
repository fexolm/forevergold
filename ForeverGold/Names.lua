local _, ns = ...

-- Названия предметов на языке клиента (у русского клиента русские) для веб-интерфейса демона.
-- AHledger отдаёт только английские названия, поэтому после входа в игру понемногу
-- спрашиваем у клиента названия всех предметов из таблицы цен и кладём их в
-- ForeverGoldDB.export.names; демон забирает их, когда игра сохранит SavedVariables.
local Names = { queue = {}, pending = {} }
ns.Names = Names

-- Сколько предметов спрашиваем за шаг и как часто шагаем: ~200 в секунду, без подвисаний.
local BATCH = 40
local STEP = 0.2

local function itemName(itemID)
	if C_Item.GetItemNameByID then
		local name = C_Item.GetItemNameByID(itemID)
		if name then
			return name
		end
	end
	return (C_Item.GetItemInfo(itemID))
end

local function names()
	ForeverGoldDB.export = ForeverGoldDB.export or {}
	ForeverGoldDB.export.names = ForeverGoldDB.export.names or {}
	return ForeverGoldDB.export.names
end

function Names:Start()
	local known = names()
	ForeverGoldDB.export.locale = GetLocale and GetLocale() or nil
	self.queue = {}
	for itemID in pairs(ns.PriceDB.ahledger or {}) do
		if not known[itemID] then
			table.insert(self.queue, itemID)
		end
	end
	table.sort(self.queue)
	if #self.queue > 0 and C_Timer.NewTicker then
		self.ticker = C_Timer.NewTicker(STEP, function() Names:Step() end)
	end
end

-- Step спрашивает следующую пачку. Названия из кэша клиента приходят сразу,
-- остальные после GET_ITEM_INFO_RECEIVED.
function Names:Step()
	local known = names()
	for _ = 1, BATCH do
		local itemID = table.remove(self.queue)
		if not itemID then
			break
		end
		local name = itemName(itemID)
		if name then
			known[itemID] = name
		else
			self.pending[itemID] = true
			C_Item.RequestLoadItemDataByID(itemID)
		end
	end
	if #self.queue == 0 and self.ticker then
		self.ticker:Cancel()
		self.ticker = nil
	end
end

ns.On("GET_ITEM_INFO_RECEIVED", function(itemID, success)
	if not Names.pending[itemID] then
		return
	end
	Names.pending[itemID] = nil
	if success then
		names()[itemID] = itemName(itemID)
	end
end)

ns.On("PLAYER_LOGIN", function() Names:Start() end)
