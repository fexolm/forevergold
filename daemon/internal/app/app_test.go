package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fexolm/forevergold/daemon/internal/store"
)

func fakeAHledger(t *testing.T, tableTime *int64) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/pricetable/"):
			etag := fmt.Sprintf(`"%d"`, *tableTime)
			if r.Header.Get("If-None-Match") == etag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Header().Set("ETag", etag)
			fmt.Fprintf(w, "AHL1|forever/normal/alliance/eu|%d|2\n2447:300:250:1000:300:310:200:400:500\n765::::::::\n", *tableTime)
		case strings.HasPrefix(r.URL.Path, "/v1/crafting/"):
			fmt.Fprintf(w, `{"recipes":[{"recipe":{"name":"Minor Healing Potion"},"result":{"id":118},"cost":50,"margin":20}],"profession":%q}`, r.URL.Query().Get("profession"))
		default:
			fmt.Fprint(w, `{"rows":[{"itemId":2447,"saving":100}]}`)
		}
	}))
}

const savedVars = `
ForeverGoldDB = {
	["export"] = {
		["version"] = 1,
		["names"] = {
			[2447] = "Мироцвет",
		},
		["scans"] = {
			{
				["t"] = 1793000000,
				["items"] = {
					[2447] = "100,150;100:50;120:100",
				},
			}, -- [1]
		},
	},
}
`

func TestSync(t *testing.T) {
	tableTime := int64(1793000500)
	srv := fakeAHledger(t, &tableTime)
	defer srv.Close()

	dir := t.TempDir()
	wow := filepath.Join(dir, "_forever_")
	addon := filepath.Join(wow, "Interface", "AddOns", "ForeverGold")
	svDir := filepath.Join(wow, "WTF", "Account", "TEST", "SavedVariables")
	for _, d := range []string{addon, svDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(svDir, "ForeverGold.lua"), []byte(savedVars), 0o644); err != nil {
		t.Fatal(err)
	}

	st, err := store.Open(filepath.Join(dir, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	cfg := DefaultConfig()
	cfg.WowPath = wow
	cfg.APIBase = srv.URL
	a := New(cfg, st)
	a.docPause = 0
	ctx := context.Background()

	a.SyncPriceTable(ctx)
	if e := a.Status()["pricetable"].Error; e != "" {
		t.Fatal(e)
	}
	lua, err := os.ReadFile(filepath.Join(addon, "AHLedgerPrices.lua"))
	if err != nil || !strings.Contains(string(lua), "2447:300:250") || !strings.Contains(string(lua), "ForeverGold_AHLedgerRaw = [==[") {
		t.Fatalf("addon prices not written: %v %s", err, lua)
	}
	l, err := st.LatestItem(2447)
	if err != nil || l == nil || l.Median7 != 300 || l.Sales10 != 500 {
		t.Fatalf("latest = %+v, %v", l, err)
	}

	// Тот же ETag: снимок не дублируется. Новый снимок: добавляется точка истории.
	a.SyncPriceTable(ctx)
	if n := a.Status()["pricetable"].Note; n != "без изменений" {
		t.Fatalf("note = %q", n)
	}
	tableTime += 900
	a.SyncPriceTable(ctx)
	series, _ := st.Series(2447, time.Unix(0, 0))
	if len(series) != 2 {
		t.Fatalf("series = %d points", len(series))
	}

	a.SyncAddon(ctx)
	if e := a.Status()["addon"].Error; e != "" {
		t.Fatal(e)
	}
	own, _ := st.OwnSeries(2447, time.Unix(0, 0))
	if len(own) != 1 || own[0].Min != 100 || own[0].Qty != 150 {
		t.Fatalf("own = %+v", own)
	}
	if book := ParseBook(own[0].Book); len(book) != 2 || book[1] != (Level{120, 100}) {
		t.Fatalf("book = %+v", book)
	}
	if found, _ := st.Search("миро", 10); len(found) != 1 || found[0].Name != "Мироцвет" {
		t.Fatalf("search = %+v", found)
	}

	// Повторное чтение того же файла ничего не добавляет.
	a.svMod = map[string]time.Time{}
	a.SyncAddon(ctx)
	if own, _ := st.OwnSeries(2447, time.Unix(0, 0)); len(own) != 1 {
		t.Fatalf("own duplicated: %d", len(own))
	}

	a.SyncDocs(ctx)
	if e := a.Status()["docs"].Error; e != "" {
		t.Fatal(e)
	}
	if _, body, _ := st.Doc("crafting-alchemy"); !strings.Contains(body, `"alchemy"`) {
		t.Fatalf("crafting doc = %s", body)
	}
}

func TestCompact(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Date(2026, 12, 31, 12, 0, 0, 0, time.UTC)
	// Точки каждые 15 минут за 40 дней.
	for ts := now.Add(-40 * 24 * time.Hour); ts.Before(now); ts = ts.Add(15 * time.Minute) {
		if _, err := st.SavePriceTable(ts, []store.PriceRow{{ItemID: 1, Min: 10, Median: 10}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.Compact(now); err != nil {
		t.Fatal(err)
	}
	count := func(from, to time.Duration) int {
		pts, _ := st.Series(1, now.Add(-from))
		n := 0
		for _, p := range pts {
			if p.T < now.Add(-to).Unix() {
				n++
			}
		}
		return n
	}
	if n := count(7*24*time.Hour, 0); n < 7*24*4-1 {
		t.Fatalf("last 7 days should keep 15-min points, got %d", n)
	}
	if n := count(30*24*time.Hour, 8*24*time.Hour); n > 23*24+1 {
		t.Fatalf("7-30 days should be hourly, got %d", n)
	}
	if n := count(40*24*time.Hour, 31*24*time.Hour); n > 10 {
		t.Fatalf("older than 30 days should be daily, got %d", n)
	}
}

func TestUseMarketResetsPrices(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Now()
	if err := st.UseMarket("forever/pve/alliance/eu"); err != nil {
		t.Fatal(err)
	}
	st.SavePriceTable(now, []store.PriceRow{{ItemID: 1, Min: 10, Median: 10}})
	if err := st.UseMarket("forever/pve/alliance/eu"); err != nil {
		t.Fatal(err)
	}
	if pts, _ := st.Series(1, now.Add(-time.Hour)); len(pts) != 1 {
		t.Fatalf("same market must keep history, got %d points", len(pts))
	}
	if err := st.UseMarket("forever/pvp/horde/us"); err != nil {
		t.Fatal(err)
	}
	if pts, _ := st.Series(1, now.Add(-time.Hour)); len(pts) != 0 {
		t.Fatalf("new market must start clean, got %d points", len(pts))
	}
	if l, _ := st.LatestItem(1); l != nil {
		t.Fatalf("latest of old market must be gone")
	}
}
