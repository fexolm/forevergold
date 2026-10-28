package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/fexolm/forevergold/daemon/internal/ahledger"
	"github.com/fexolm/forevergold/daemon/internal/store"
)

const (
	catalogInterval = 10 * time.Minute
	// backfillInterval: как часто докачивать историю ликвидных предметов для вотчлиста и индикаторов.
	backfillInterval = 3 * time.Hour
	backfillItems    = 300
)

// histRanges: диапазоны /v1/prices, шаг их точек и как долго скачанное считается свежим.
var histRanges = map[string]struct {
	Res int64
	TTL time.Duration
}{
	"24h": {0, 15 * time.Minute},
	"7d":  {3600, time.Hour},
	"30d": {86400, 6 * time.Hour},
	"90d": {86400, 12 * time.Hour},
}

// SyncCatalog докачивает английскую справку AHledger и русские названия Wowhead для предметов с ценами.
func (a *App) SyncCatalog(ctx context.Context) {
	metaN, err := a.syncMeta(ctx)
	if err == nil {
		err = a.syncDocNames()
	}
	if err != nil {
		a.report("catalog", "", err)
		return
	}
	ruN, ruErr := a.syncRuNames(ctx)
	// Список предметов для аддона мог пополниться: переписываем файл цен вместе с ним.
	a.mu.Lock()
	pt := a.lastTable
	a.mu.Unlock()
	if pt != nil {
		if err := a.WriteAddonPrices(pt); err != nil {
			log.Printf("запись в аддон: %v", err)
		}
	}
	a.report("catalog", fmt.Sprintf("справка %d, русских названий %d", metaN, ruN), ruErr)
}

// syncDocNames заводит предметы, которые упоминаются в документах AHledger, но могут не продаваться
// (результаты рецептов, реагенты): им тоже нужны русские названия.
func (a *App) syncDocNames() error {
	names := map[int64]string{}
	for kind := range a.docPaths() {
		_, body, err := a.Store.Doc(kind)
		if err != nil || body == "" {
			continue
		}
		var doc any
		if json.Unmarshal([]byte(body), &doc) == nil {
			collectNames(doc, names)
		}
	}
	return a.Store.SaveDocNames(names)
}

// collectNames собирает пары id → name из любого объекта документа.
func collectNames(v any, out map[int64]string) {
	switch x := v.(type) {
	case map[string]any:
		id, ok1 := x["id"].(float64)
		name, ok2 := x["name"].(string)
		if ok1 && ok2 && id > 0 && name != "" {
			out[int64(id)] = name
		}
		for _, c := range x {
			collectNames(c, out)
		}
	case []any:
		for _, c := range x {
			collectNames(c, out)
		}
	}
}

func (a *App) syncMeta(ctx context.Context) (int, error) {
	n := 0
	for {
		ids, err := a.Store.MissingMeta(100)
		if err != nil || len(ids) == 0 {
			return n, err
		}
		items, err := a.Client.Tooltip(ctx, a.Cfg.Market, ids)
		if err != nil {
			return n, err
		}
		got := map[int64]bool{}
		list := make([]store.Meta, 0, len(ids))
		for _, it := range items {
			got[it.ID] = true
			list = append(list, store.Meta{ItemID: it.ID, NameEn: it.Name, Quality: it.Quality, Icon: it.Icon, ItemClass: it.ItemClass, Level: it.Level})
		}
		// Чего AHledger не знает, помечаем пустой справкой, чтобы не спрашивать снова.
		for _, id := range ids {
			if !got[id] {
				list = append(list, store.Meta{ItemID: id})
			}
		}
		if err := a.Store.SaveMeta(list); err != nil {
			return n, err
		}
		n += len(items)
	}
}

// syncRuNames идёт по Wowhead не быстрее 3 запросов в секунду, самые ликвидные первыми.
func (a *App) syncRuNames(ctx context.Context) (int, error) {
	if a.Wowhead == nil {
		return 0, nil
	}
	n, fails := 0, 0
	for {
		ids, err := a.Store.MissingRu(50)
		if err != nil || len(ids) == 0 {
			return n, err
		}
		for _, id := range ids {
			name, err := a.Wowhead.RuName(ctx, id)
			if ctx.Err() != nil {
				return n, ctx.Err()
			}
			if err != nil {
				fails++
				log.Printf("wowhead: %v", err)
				if fails >= 5 {
					return n, fmt.Errorf("wowhead недоступен: %w", err)
				}
				continue
			}
			if err := a.Store.SaveRuName(id, name); err != nil {
				return n, err
			}
			if name != "" {
				n++
			}
			select {
			case <-ctx.Done():
				return n, ctx.Err()
			case <-time.After(330 * time.Millisecond):
			}
		}
	}
}

// histLocks не даёт двум запросам качать историю одного предмета одновременно.
var histLocks sync.Map

// EnsureHistory докачивает историю предмета из AHledger, если сохранённая устарела.
func (a *App) EnsureHistory(ctx context.Context, id int64, rng string) error {
	r, ok := histRanges[rng]
	if !ok {
		return fmt.Errorf("неизвестный диапазон %q", rng)
	}
	if time.Since(a.Store.HistFetched(id, rng)) < r.TTL {
		return nil
	}
	mu, _ := histLocks.LoadOrStore(fmt.Sprintf("%d/%s", id, rng), &sync.Mutex{})
	mu.(*sync.Mutex).Lock()
	defer mu.(*sync.Mutex).Unlock()
	if time.Since(a.Store.HistFetched(id, rng)) < r.TTL {
		return nil
	}
	p, err := a.Client.PriceHistory(ctx, a.Cfg.Market, id, rng)
	if err != nil {
		return err
	}
	rows := make([]store.HistRow, 0, len(p.Series))
	for _, pt := range p.Series {
		rows = append(rows, histRow(pt, r.Res))
	}
	return a.Store.SaveHist(id, rng, rows)
}

func histRow(p ahledger.HistPoint, res int64) store.HistRow {
	return store.HistRow{T: p.T.Unix(), Res: res, Min: p.Min, Median: p.Median, P25: p.P25, P75: p.P75, Qty: p.Quantity, Auctions: p.Auctions}
}

// EnsureItemInfo докачивает подкласс и цену у вендора, если их ещё нет.
func (a *App) EnsureItemInfo(ctx context.Context, id int64) {
	m, _ := a.Store.ItemMeta(id)
	if m.VendorSell >= 0 {
		return
	}
	it, err := a.Client.Item(ctx, id)
	if err != nil {
		log.Printf("item %d: %v", id, err)
		return
	}
	a.Store.SaveItemInfo(id, it.ItemSubclass, it.VendorSell)
}

// SyncBackfill держит 7д и 30д историю самых ликвидных предметов: из неё строятся спарклайны и индикаторы.
func (a *App) SyncBackfill(ctx context.Context) {
	list, err := a.Store.Liquid(0, backfillItems)
	if err != nil {
		a.report("history", "", err)
		return
	}
	fails := 0
	var lastErr error
	for _, l := range list {
		for _, rng := range []string{"7d", "30d"} {
			if ctx.Err() != nil {
				return
			}
			if err := a.EnsureHistory(ctx, l.ItemID, rng); err != nil {
				fails++
				lastErr = err
				if fails >= 10 {
					a.report("history", "", fmt.Errorf("история: %w", err))
					return
				}
				continue
			}
		}
	}
	note := fmt.Sprintf("история %d предметов", len(list))
	if lastErr != nil {
		log.Printf("history: %d ошибок, последняя: %v", fails, lastErr)
	}
	a.report("history", note, nil)
}
