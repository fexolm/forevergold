local _, ns = ...

-- Одно окно справа от аукциона: статус, кнопка скана, список сделок и большая кнопка покупки.
local UI = {}
ns.UI = UI

local WIDTH = 380
local LINE_HEIGHT = 16

local frame = CreateFrame("Frame", "ForeverGoldFrame", UIParent, "BasicFrameTemplateWithInset")
frame:SetSize(WIDTH, 120 + ns.Config.LIST_SIZE * LINE_HEIGHT + 60)
frame:Hide()
frame.TitleText:SetText("ForeverGold")

local status = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
status:SetPoint("TOPLEFT", 12, -30)
status:SetPoint("RIGHT", -12, 0)
status:SetJustifyH("LEFT")

local moneyText = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
moneyText:SetPoint("TOPLEFT", status, "BOTTOMLEFT", 0, -4)
moneyText:SetPoint("RIGHT", -12, 0)
moneyText:SetJustifyH("LEFT")

local scanButton = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
scanButton:SetSize(120, 22)
scanButton:SetPoint("TOPLEFT", moneyText, "BOTTOMLEFT", 0, -6)
scanButton:SetScript("OnClick", function() ns.Scanner:Start() end)

local lines = {}
for i = 1, ns.Config.LIST_SIZE do
	local line = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	line:SetPoint("TOPLEFT", scanButton, "BOTTOMLEFT", 0, -6 - (i - 1) * LINE_HEIGHT)
	line:SetPoint("RIGHT", -12, 0)
	line:SetJustifyH("LEFT")
	line:SetWordWrap(false)
	lines[i] = line
end

-- Глобальное имя нужно для привязки клавиши (Bindings.xml).
local buyButton = CreateFrame("Button", "ForeverGoldBuyButton", frame, "UIPanelButtonTemplate")
buyButton:SetHeight(36)
buyButton:SetPoint("BOTTOMLEFT", 12, 12)
buyButton:SetPoint("BOTTOMRIGHT", -12, 12)
buyButton:RegisterForClicks("AnyUp", "AnyDown")
buyButton:SetScript("OnClick", function(_, _, down)
	-- Клавиша присылает и нажатие, и отпускание; шаг делаем один раз.
	if down then
		return
	end
	ns.Buyer:Step()
end)

function UI:SetStatus(text)
	status:SetText(text)
end

function UI:Refresh()
	if not frame:IsShown() then
		return
	end
	moneyText:SetText(string.format("Доступно: %s   резерв: %s   потрачено: %s",
		ns.Money(ns.SpendableCopper()), ns.Money(ns.ReserveCopper()), ns.Money(ns.Buyer.spent)))

	local left = ns.Scanner:CooldownLeft()
	scanButton:SetText(left > 0 and string.format("Скан (%d мин)", math.ceil(left / 60)) or "Полный скан")
	scanButton:SetEnabled(left == 0 and not ns.Scanner.running)

	local deals = ns.Deals.list
	for i, line in ipairs(lines) do
		local d = deals[i]
		if d then
			line:SetText(string.format("%s  |cffffffff%s|r -> %s  [%s]  ~%s",
				d.name, ns.Money(d.minPrice), ns.Money(d.target), d.kind, ns.Money(d.estProfit)))
		else
			line:SetText(i == 1 and "Сделок пока нет. Сделайте полный скан." or "")
		end
	end

	buyButton:SetText(ns.Buyer:Label())
end

function UI:Toggle()
	frame:SetShown(not frame:IsShown())
	self:Refresh()
end

local function statusLine()
	local db = ns.PriceDB
	if db.ahledgerTime then
		local age = math.floor((time() - db.ahledgerTime) / 60)
		return string.format("AHledger: %d предметов, обновлено %d мин назад", db.ahledgerCount, age)
	end
	return "AHledger не подключён, цены только по своим сканам"
end

ns.On("AUCTION_HOUSE_SHOW", function()
	frame:ClearAllPoints()
	if AuctionHouseFrame then
		frame:SetPoint("TOPLEFT", AuctionHouseFrame, "TOPRIGHT", 4, 0)
	else
		frame:SetPoint("CENTER")
	end
	frame:Show()
	UI:SetStatus(statusLine())
	UI:Refresh()
	ns.Buyer:Prefetch()
end)

ns.On("AUCTION_HOUSE_CLOSED", function()
	frame:Hide()
end)

ns.On("PLAYER_MONEY", function() UI:Refresh() end)

-- Таймер скана на кнопке обновляем раз в 10 секунд.
C_Timer.NewTicker(10, function() UI:Refresh() end)
