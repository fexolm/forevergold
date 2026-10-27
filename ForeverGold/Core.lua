local addonName, ns = ...

ns.events = CreateFrame("Frame")
local handlers = {}

-- ns.On("EVENT", fn) подписывает fn(...) на событие игры. Несколько подписчиков на одно событие допустимы.
function ns.On(event, fn)
	if not handlers[event] then
		handlers[event] = {}
		ns.events:RegisterEvent(event)
	end
	table.insert(handlers[event], fn)
end

ns.events:SetScript("OnEvent", function(_, event, ...)
	for _, fn in ipairs(handlers[event]) do
		fn(...)
	end
end)

function ns.Print(fmt, ...)
	print("|cffe6c200ForeverGold:|r " .. string.format(fmt, ...))
end

function ns.Money(copper)
	copper = math.floor(copper or 0)
	if GetMoneyString then
		return GetMoneyString(copper, true)
	end
	return string.format("%dg %02ds %02dc", copper / 10000, (copper / 100) % 100, copper % 100)
end

function ns.ReserveCopper()
	local gold = ForeverGoldDB.reserveGold or ns.Config.RESERVE_GOLD
	return gold * 10000
end

-- Сколько можно потратить, не залезая в резерв.
function ns.SpendableCopper()
	return math.max(0, GetMoney() - ns.ReserveCopper())
end

ns.ahOpen = false
ns.On("AUCTION_HOUSE_SHOW", function() ns.ahOpen = true end)
ns.On("AUCTION_HOUSE_CLOSED", function() ns.ahOpen = false end)

ns.On("ADDON_LOADED", function(name)
	if name ~= addonName then
		return
	end
	ForeverGoldDB = ForeverGoldDB or {}
	ForeverGoldDB.items = ForeverGoldDB.items or {}
	ns.PriceDB:Init()
	if ns.PriceDB.ahledgerTime then
		ns.Print("данные AHledger от %s, предметов: %d", date("%d.%m %H:%M", ns.PriceDB.ahledgerTime), ns.PriceDB.ahledgerCount)
	end
end)

BINDING_HEADER_FOREVERGOLD = "ForeverGold"
_G["BINDING_NAME_CLICK ForeverGoldBuyButton:LeftButton"] = "Следующая покупка"

SLASH_FOREVERGOLD1 = "/fg"
SlashCmdList.FOREVERGOLD = function(msg)
	local cmd, arg = msg:match("^(%S*)%s*(.-)$")
	if cmd == "scan" then
		ns.Scanner:Start()
	elseif cmd == "reserve" then
		local gold = tonumber(arg)
		if gold then
			ForeverGoldDB.reserveGold = gold
		end
		ns.Print("резерв: %s", ns.Money(ns.ReserveCopper()))
	elseif cmd == "price" then
		local itemID = tonumber(arg) or (arg ~= "" and C_Item.GetItemInfoInstant(arg))
		if itemID then
			ns.Print("%s: рынок %s, продаж в день %s", arg, ns.Money(ns.PriceDB:Market(itemID)), tostring(ns.PriceDB:SalesPerDay(itemID)))
		end
	else
		ns.UI:Toggle()
	end
end
