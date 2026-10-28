// Package app связывает синк AHledger, обмен данными с аддоном и хранилище.
package app

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/fexolm/forevergold/daemon/internal/ahledger"
	"github.com/fexolm/forevergold/daemon/internal/savedvars"
	"github.com/fexolm/forevergold/daemon/internal/store"
)

type Config struct {
	// WowPath это папка клиента Forever (та, где лежат Interface и WTF), например C:\...\World of Warcraft\_forever_.
	WowPath     string   `json:"wowPath"`
	Market      string   `json:"market"`
	Listen      string   `json:"listen"`
	APIBase     string   `json:"apiBase,omitempty"`
	Professions []string `json:"professions"`
}

func DefaultConfig() Config {
	return Config{
		Market:      "forever.normal.alliance.eu",
		Listen:      "127.0.0.1:8765",
		Professions: []string{"alchemy", "blacksmithing"},
	}
}

const (
	priceInterval   = 15 * time.Minute
	docsInterval    = 15 * time.Minute
	addonInterval   = 10 * time.Second
	compactInterval = 6 * time.Hour
)

type App struct {
	Cfg    Config
	Store  *store.Store
	Client *ahledger.Client

	mu     sync.Mutex
	status map[string]JobStatus

	svMod     map[string]time.Time
	lastTable *ahledger.PriceTable
	// docPause: пауза между JSON-запросами (лимит аналитики 60 в минуту).
	docPause time.Duration
}

type JobStatus struct {
	LastRun time.Time  `json:"lastRun"`
	LastOK  *time.Time `json:"lastOk,omitempty"`
	Error   string     `json:"error,omitempty"`
	Note    string     `json:"note,omitempty"`
}

func New(cfg Config, st *store.Store) *App {
	return &App{
		Cfg:      cfg,
		Store:    st,
		Client:   ahledger.New(cfg.APIBase),
		status:   map[string]JobStatus{},
		svMod:    map[string]time.Time{},
		docPause: 2 * time.Second,
	}
}

func (a *App) Status() map[string]JobStatus {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make(map[string]JobStatus, len(a.status))
	for k, v := range a.status {
		out[k] = v
	}
	return out
}

func (a *App) report(job string, note string, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := a.status[job]
	s.LastRun = time.Now()
	if err != nil {
		s.Error = err.Error()
		log.Printf("%s: %v", job, err)
	} else {
		s.Error = ""
		ok := s.LastRun
		s.LastOK = &ok
		if note != "" {
			s.Note = note
		}
	}
	a.status[job] = s
}

// Run крутит все фоновые задачи до отмены контекста.
func (a *App) Run(ctx context.Context) {
	var wg sync.WaitGroup
	loop := func(every time.Duration, fn func(context.Context)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fn(ctx)
			t := time.NewTicker(every)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					fn(ctx)
				}
			}
		}()
	}
	loop(priceInterval, a.SyncPriceTable)
	loop(docsInterval, a.SyncDocs)
	loop(addonInterval, a.SyncAddon)
	loop(compactInterval, func(context.Context) { a.report("compact", "", a.Store.Compact(time.Now())) })
	wg.Wait()
}

func (a *App) SyncPriceTable(ctx context.Context) {
	raw, err := a.Client.Get(ctx, "/v1/pricetable/"+a.Cfg.Market)
	if errors.Is(err, ahledger.ErrNotModified) {
		a.report("pricetable", "без изменений", nil)
		return
	}
	if err != nil {
		a.report("pricetable", "", err)
		return
	}
	pt, err := ahledger.ParsePriceTable(raw)
	if err != nil {
		a.report("pricetable", "", err)
		return
	}
	rows := make([]store.PriceRow, len(pt.Rows))
	for i, r := range pt.Rows {
		rows[i] = store.PriceRow{ItemID: r.ItemID, Min: r.MinBuyout, Median: r.Median, Qty: r.Quantity,
			Median7: r.Median7d, Median30: r.Median30d, Low30: r.Low30d, High30: r.High30d, Sales10: r.SalesX10}
	}
	added, err := a.Store.SavePriceTable(pt.Time, rows)
	if err != nil {
		a.report("pricetable", "", err)
		return
	}
	a.mu.Lock()
	a.lastTable = pt
	a.mu.Unlock()
	note := fmt.Sprintf("%d предметов, снимок %s", len(rows), pt.Time.Local().Format("02.01 15:04"))
	if !added {
		note += " (уже был)"
	}
	if err := a.WriteAddonPrices(pt); err != nil {
		a.report("pricetable", "", fmt.Errorf("запись в аддон: %w", err))
		return
	}
	a.report("pricetable", note, nil)
}

// docPaths: какие JSON-эндпоинты держим локально. Ключ = вид документа для веб-интерфейса.
func (a *App) docPaths() map[string]string {
	m := a.Cfg.Market
	paths := map[string]string{
		"deals":     "/v1/deals/" + m + "?discount=25&sells=1&limit=200",
		"signals":   "/v1/signals/" + m + "?discount=20&days=7",
		"structure": "/v1/structure/" + m,
		"economy":   "/v1/economy/" + m,
	}
	for _, p := range a.Cfg.Professions {
		paths["crafting-"+p] = "/v1/crafting/" + m + "?profession=" + url.QueryEscape(p) + "&all=1"
	}
	return paths
}

func (a *App) SyncDocs(ctx context.Context) {
	var failed []string
	n := 0
	for kind, path := range a.docPaths() {
		body, err := a.Client.Get(ctx, path)
		if errors.Is(err, ahledger.ErrNotModified) {
			continue
		}
		if err == nil {
			err = a.Store.SaveDoc(kind, time.Now(), body)
		}
		if err != nil {
			log.Printf("docs %s: %v", kind, err)
			failed = append(failed, kind)
			continue
		}
		n++
		select {
		case <-ctx.Done():
			return
		case <-time.After(a.docPause):
		}
	}
	var err error
	if len(failed) > 0 {
		err = fmt.Errorf("не скачались: %s", strings.Join(failed, ", "))
	}
	a.report("docs", fmt.Sprintf("обновлено %d", n), err)
}

func (a *App) addonDir() string {
	if a.Cfg.WowPath == "" {
		return ""
	}
	return filepath.Join(a.Cfg.WowPath, "Interface", "AddOns", "ForeverGold")
}

// WriteAddonPrices пишет таблицу цен в аддон в том же формате, что читает PriceDB.lua.
func (a *App) WriteAddonPrices(pt *ahledger.PriceTable) error {
	dir := a.addonDir()
	if dir == "" {
		return nil
	}
	if _, err := os.Stat(dir); err != nil {
		return nil // аддон не установлен, нечего обновлять
	}
	text := strings.ReplaceAll(string(pt.Raw), "]==]", "")
	lua := fmt.Sprintf("-- Сгенерировано forevergold.exe %s. Данные: https://ahledger.com\nForeverGold_AHLedgerRaw = [==[\n%s\n]==]\n",
		time.Now().Format(time.RFC3339), text)
	return writeAtomic(filepath.Join(dir, "AHLedgerPrices.lua"), []byte(lua))
}

func writeAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// SyncAddon забирает сканы и названия из SavedVariables, когда игра их перезаписала.
func (a *App) SyncAddon(ctx context.Context) {
	if a.Cfg.WowPath == "" {
		return
	}
	files, _ := filepath.Glob(filepath.Join(a.Cfg.WowPath, "WTF", "Account", "*", "SavedVariables", "ForeverGold.lua"))
	for _, f := range files {
		info, err := os.Stat(f)
		if err != nil || !info.ModTime().After(a.svMod[f]) {
			continue
		}
		scans, names, err := a.ingestSavedVars(f)
		if err != nil {
			a.report("addon", "", err)
			continue
		}
		a.svMod[f] = info.ModTime()
		a.report("addon", fmt.Sprintf("новых сканов %d, названий %d (%s)", scans, names, info.ModTime().Format("02.01 15:04")), nil)
	}
}

func (a *App) ingestSavedVars(path string) (int, int, error) {
	src, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, err
	}
	vars, err := savedvars.Parse(string(src))
	if err != nil {
		return 0, 0, err
	}
	export := savedvars.Get(vars["ForeverGoldDB"], "export")
	if export == nil {
		return 0, 0, nil
	}

	names := map[int64]string{}
	if t, ok := savedvars.Get(export, "names").(savedvars.Table); ok {
		for k, v := range t {
			id, ok1 := savedvars.Int(k)
			name, ok2 := v.(string)
			if ok1 && ok2 && name != "" {
				names[id] = name
			}
		}
	}
	if err := a.Store.SaveNames(names); err != nil {
		return 0, 0, err
	}

	added := 0
	for _, scan := range savedvars.Array(savedvars.Get(export, "scans")) {
		unix, ok := savedvars.Int(savedvars.Get(scan, "t"))
		if !ok {
			continue
		}
		var items []store.OwnScanItem
		if t, ok := savedvars.Get(scan, "items").(savedvars.Table); ok {
			for k, v := range t {
				id, ok1 := savedvars.Int(k)
				book, ok2 := v.(string)
				if !ok1 || !ok2 {
					continue
				}
				min, qty := ParseBookHeader(book)
				items = append(items, store.OwnScanItem{ItemID: id, Min: min, Qty: qty, Book: book})
			}
		}
		ok, err := a.Store.SaveOwnScan(time.Unix(unix, 0), items)
		if err != nil {
			return added, len(names), err
		}
		if ok {
			added++
		}
	}
	return added, len(names), nil
}

// ParseBookHeader читает "min,qty" из начала строки стакана "min,qty;цена:штук;...".
func ParseBookHeader(book string) (int64, int64) {
	head, _, _ := strings.Cut(book, ";")
	a, b, _ := strings.Cut(head, ",")
	min, _ := strconv.ParseInt(a, 10, 64)
	qty, _ := strconv.ParseInt(b, 10, 64)
	return min, qty
}

type Level struct {
	Price int64 `json:"price"`
	Qty   int64 `json:"qty"`
}

func ParseBook(book string) []Level {
	parts := strings.Split(book, ";")
	var out []Level
	for _, p := range parts[1:] {
		a, b, ok := strings.Cut(p, ":")
		if !ok {
			continue
		}
		price, err1 := strconv.ParseInt(a, 10, 64)
		qty, err2 := strconv.ParseInt(b, 10, 64)
		if err1 == nil && err2 == nil {
			out = append(out, Level{price, qty})
		}
	}
	return out
}
