# API демона для веб-терминала

Все цены в меди (10000 = 1з). Время в unix-секундах. Списки всегда массивы (`[]`, не `null`).

## Метаданные предмета (поля в любом списке предметов)

`itemId, name` (русское, если известно, иначе английское; никогда не пусто), `nameEn`, `quality` (`POOR|COMMON|UNCOMMON|RARE|EPIC|LEGENDARY` или пусто), `icon` (URL картинки или пусто), `itemClass`.

## GET /api/status

`{market, marketLabel, marketStatus, pricesAsOf, wowPath, professions, jobs:{name:{lastRun,lastOk,error,note}}, counts:{...}}`
`pricesAsOf` — unix времени последнего снимка таблицы цен (0, если нет). `marketStatus`: `scanned` или `not open yet`.

## GET /api/markets

`[{id, label, region, open}]` — все рынки Forever. `open` = есть цены.

## POST /api/market  `{"market":"forever.normal.alliance.us"}`

Переключает рынок (пишет config.json, чистит цены старого рынка, запускает синк). Ответ `{ok:true}`.

## GET /api/instruments?limit=300

Ликвидные предметы для вотчлиста и скринеров, сортировка по ликвидности. Каждый элемент:
метаданные + `t, min, median, qty, median7, median30, low30, high30, salesPerDay` (float, 0 = нет оценки) +
`spark: [[t, median], ...]` (почасовая история за 7д, может быть пустой) +
`ind: {discount, z, rangePos, dos, momentum, volatility, liquidity, change24h, histDays}`
(любое поле может быть `null`, если данных не хватает; доли, не проценты: 0.25 = 25%).

## GET /api/search?q=

До 50 предметов: метаданные + те же поля цен и `ind`, без `spark`.

## GET /api/item/{id}?range=24h|7d|30d|90d

```
{
  item: {метаданные, itemSubclass, level, vendorSell},
  latest: {t, min, median, qty, median7, median30, low30, high30, salesPerDay},
  ind: {...как выше},
  series: [{t, min, median, p25, p75, qty, auctions}],   // история AHledger за range + свои снимки демона
  snapshots: [{t, min, median, qty}],                     // снимки таблицы цен демона (~15 мин) за range, для свечей
  own: [{t, min, qty}],                                   // сканы аддона игрока за range
  book: [{price, qty}], bookTime,                         // стакан из последнего своего скана (может быть пуст)
  from, to                                                // границы оси X: [now-range, now]
}
```

## GET /api/item/{id}/forecast

`{ok, note, days, trendPerDay, hourly[24], weekday[7], volatility, base, points:[{t,mid,low,high}], cheapestSlot:{weekday,hour}, dearestSlot}`.

## GET /api/opportunities

Предметы с прогнозом роста: метаданные + цены + `sellAt, sellMid, sellLow, gain, trendPerDay, volatility, cheapest`.

## GET /api/doc/{kind}

Сырые ответы AHledger (заголовок `X-Fetched-At`): `deals`, `signals`, `structure`, `economy`, `disenchant`, `crafting-<профессия>`.
Демон дописывает в каждый объект `item: {id, ...}` поле `ruName` (русское название, если известно).

## POST /api/sync

Запустить синк вручную.
