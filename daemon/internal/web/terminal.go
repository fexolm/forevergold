package web

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/fexolm/forevergold/daemon/internal/ahledger"
	"github.com/fexolm/forevergold/daemon/internal/app"
	"github.com/fexolm/forevergold/daemon/internal/store"
)

// Instrument: строка вотчлиста и скринеров.
type Instrument struct {
	store.Latest
	SalesPerDay float64    `json:"salesPerDay"`
	Spark       [][2]int64 `json:"spark,omitempty"`
	Ind         Ind        `json:"ind"`
}

func instrument(l store.Latest, hist []store.HistRow, snaps []store.Point, withSpark bool) Instrument {
	in := Instrument{Latest: l, SalesPerDay: float64(l.Sales10) / 10, Ind: computeInd(l, points(hist, snaps))}
	if withSpark {
		in.Spark = spark(hist, snaps, time.Unix(l.T, 0))
	}
	return in
}

// enrich считает индикаторы для списка предметов одним проходом по базе.
func (s *Server) enrich(list []store.Latest, withSpark bool) ([]Instrument, error) {
	ids := make([]int64, len(list))
	for i, l := range list {
		ids[i] = l.ItemID
	}
	since := time.Now().Add(-35 * 24 * time.Hour)
	hist, err := s.App.Store.HistBulk(ids, -1, since)
	if err != nil {
		return nil, err
	}
	snaps, err := s.App.Store.SeriesBulk(ids, since)
	if err != nil {
		return nil, err
	}
	out := make([]Instrument, len(list))
	for i, l := range list {
		out[i] = instrument(l, hist[l.ItemID], snaps[l.ItemID], withSpark)
	}
	return out, nil
}

func (s *Server) instruments(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 1000 {
		limit = 300
	}
	list, err := s.App.Store.Liquid(0, limit)
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	out, err := s.enrich(list, true)
	writeJSON(w, out, err)
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	list, err := s.App.Store.Search(r.URL.Query().Get("q"), 50)
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	out, err := s.enrich(list, false)
	writeJSON(w, out, err)
}

var rangeSpan = map[string]time.Duration{
	"24h": 24 * time.Hour,
	"7d":  7 * 24 * time.Hour,
	"30d": 30 * 24 * time.Hour,
	"90d": 90 * 24 * time.Hour,
}

// SeriesPoint: точка графика. P25/P75 = 0 у своих снимков (их нет в таблице цен).
type SeriesPoint struct {
	T        int64 `json:"t"`
	Min      int64 `json:"min"`
	Median   int64 `json:"median"`
	P25      int64 `json:"p25"`
	P75      int64 `json:"p75"`
	Qty      int64 `json:"qty"`
	Auctions int64 `json:"auctions"`
}

func (s *Server) item(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	rng := r.URL.Query().Get("range")
	// Старые названия диапазонов из прежнего интерфейса.
	if rng == "1d" {
		rng = "24h"
	}
	span, ok := rangeSpan[rng]
	if !ok {
		rng, span = "7d", rangeSpan["7d"]
	}
	st := s.App.Store

	// История AHledger докачивается при открытии предмета; без сети показываем то, что уже есть.
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for _, rr := range []string{rng, "30d"} {
		wg.Add(1)
		go func(rr string) {
			defer wg.Done()
			if err := s.App.EnsureHistory(ctx, id, rr); err != nil {
				log.Printf("history %d %s: %v", id, rr, err)
			}
		}(rr)
	}
	wg.Add(1)
	go func() { defer wg.Done(); s.App.EnsureItemInfo(ctx, id) }()
	wg.Wait()

	now := time.Now()
	from := now.Add(-span)
	meta, _ := st.ItemMeta(id)
	latest, err := st.LatestItem(id)
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	res := histRanges(rng)
	hist, err := st.Hist(id, res, from)
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	snaps, err := st.Series(id, from)
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	series := make([]SeriesPoint, 0, len(hist)+len(snaps))
	last := int64(0)
	for _, h := range hist {
		series = append(series, SeriesPoint{h.T, h.Min, h.Median, h.P25, h.P75, h.Qty, 0})
		series[len(series)-1].Auctions = h.Auctions
		last = h.T
	}
	// Свои снимки дописываем после истории AHledger: на коротких диапазонах все, на длинных только последний.
	tail := []store.Point{}
	for _, p := range snaps {
		if p.T > last+600 {
			tail = append(tail, p)
		}
	}
	if res == 86400 && len(tail) > 1 {
		tail = tail[len(tail)-1:]
	}
	for _, p := range tail {
		series = append(series, SeriesPoint{T: p.T, Min: p.Min, Median: p.Median, Qty: p.Qty})
	}
	sort.Slice(series, func(i, j int) bool { return series[i].T < series[j].T })

	own, err := st.OwnSeries(id, from)
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	var book []app.Level
	var bookTime int64
	if last, err := st.OwnSeries(id, time.Unix(0, 0)); err == nil && len(last) > 0 {
		book, bookTime = app.ParseBook(last[len(last)-1].Book), last[len(last)-1].T
	}
	if book == nil {
		book = []app.Level{}
	}
	for i := range own {
		own[i].Book = ""
	}

	resp := map[string]any{
		"item":      meta,
		"series":    series,
		"snapshots": snaps,
		"own":       own,
		"book":      book,
		"bookTime":  bookTime,
		"from":      from.Unix(),
		"to":        now.Unix(),
		"range":     rng,
	}
	if latest != nil {
		hist30, _ := st.Hist(id, -1, now.Add(-35*24*time.Hour))
		snaps30, _ := st.Series(id, now.Add(-35*24*time.Hour))
		in := instrument(*latest, hist30, snaps30, false)
		resp["latest"] = struct {
			store.Latest
			SalesPerDay float64 `json:"salesPerDay"`
		}{in.Latest, in.SalesPerDay}
		resp["ind"] = in.Ind
	}
	writeJSON(w, resp, nil)
}

func histRanges(rng string) int64 {
	switch rng {
	case "24h":
		return 0
	case "7d":
		return 3600
	}
	return 86400
}

type marketCache struct {
	mu   sync.Mutex
	at   time.Time
	list []ahledger.MarketInfo
}

func (s *Server) marketList(ctx context.Context) ([]ahledger.MarketInfo, error) {
	s.markets.mu.Lock()
	defer s.markets.mu.Unlock()
	if s.markets.list != nil && time.Since(s.markets.at) < 10*time.Minute {
		return s.markets.list, nil
	}
	list, err := s.App.Client.Markets(ctx)
	if err != nil {
		if s.markets.list != nil {
			return s.markets.list, nil
		}
		return nil, err
	}
	s.markets.at, s.markets.list = time.Now(), list
	return list, nil
}

func (s *Server) marketsHandler(w http.ResponseWriter, r *http.Request) {
	list, err := s.marketList(r.Context())
	writeJSON(w, list, err)
}

func (s *Server) setMarket(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Market string `json:"market"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Market == "" {
		http.Error(w, "нужен market", http.StatusBadRequest)
		return
	}
	list, err := s.marketList(r.Context())
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	known := false
	for _, m := range list {
		known = known || m.ID == req.Market
	}
	if !known {
		http.Error(w, "неизвестный рынок", http.StatusBadRequest)
		return
	}
	s.opps.mu.Lock()
	s.opps.list = nil
	s.opps.mu.Unlock()
	writeJSON(w, map[string]bool{"ok": true}, s.App.SetMarket(req.Market))
}

// addRuNames дописывает ruName каждому объекту с числовым id, у которого есть русское название.
func addRuNames(v any, names map[int64]string) {
	switch x := v.(type) {
	case map[string]any:
		if id, ok := x["id"].(float64); ok {
			if _, hasName := x["name"]; hasName {
				if ru := names[int64(id)]; ru != "" {
					x["ruName"] = ru
				}
			}
		}
		for _, c := range x {
			addRuNames(c, names)
		}
	case []any:
		for _, c := range x {
			addRuNames(c, names)
		}
	}
}
