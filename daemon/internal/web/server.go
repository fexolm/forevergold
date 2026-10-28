// Package web отдаёт локальный веб-интерфейс и JSON API для него.
package web

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"strconv"
	"time"

	"github.com/fexolm/forevergold/daemon/internal/app"
)

//go:embed static
var static embed.FS

type Server struct {
	App  *app.App
	opps oppCache
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(static, "static")
	mux.Handle("/", http.FileServer(http.FS(sub)))
	mux.HandleFunc("GET /api/status", s.status)
	mux.HandleFunc("GET /api/search", s.search)
	mux.HandleFunc("GET /api/movers", s.movers)
	mux.HandleFunc("GET /api/item/{id}", s.item)
	mux.HandleFunc("GET /api/item/{id}/forecast", s.forecast)
	mux.HandleFunc("GET /api/opportunities", s.opportunities)
	mux.HandleFunc("GET /api/doc/{kind}", s.doc)
	mux.HandleFunc("POST /api/sync", s.sync)
	return mux
}

func writeJSON(w http.ResponseWriter, v any, err error) {
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	counts, err := s.App.Store.Counts()
	writeJSON(w, map[string]any{
		"market":      s.App.Cfg.Market,
		"wowPath":     s.App.Cfg.WowPath,
		"professions": s.App.Cfg.Professions,
		"jobs":        s.App.Status(),
		"counts":      counts,
	}, err)
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	list, err := s.App.Store.Search(r.URL.Query().Get("q"), 50)
	writeJSON(w, list, err)
}

func (s *Server) movers(w http.ResponseWriter, r *http.Request) {
	// Не меньше 1 продажи в день (sales10 >= 10).
	list, err := s.App.Store.Movers(10, 50)
	writeJSON(w, list, err)
}

var ranges = map[string]time.Duration{
	"1d":  24 * time.Hour,
	"7d":  7 * 24 * time.Hour,
	"30d": 30 * 24 * time.Hour,
	"90d": 90 * 24 * time.Hour,
}

func (s *Server) item(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	span, ok := ranges[r.URL.Query().Get("range")]
	if !ok {
		span = ranges["7d"]
	}
	since := time.Now().Add(-span)
	st := s.App.Store

	latest, err := st.LatestItem(id)
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	series, err := st.Series(id, since)
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	own, err := st.OwnSeries(id, since)
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	// Стакан берём из последнего своего скана, в истории оставляем только min/qty.
	var book []app.Level
	var bookTime int64
	if len(own) == 0 {
		if last, err := st.OwnSeries(id, time.Unix(0, 0)); err == nil && len(last) > 0 {
			own = nil
			book, bookTime = app.ParseBook(last[len(last)-1].Book), last[len(last)-1].T
		}
	} else {
		book, bookTime = app.ParseBook(own[len(own)-1].Book), own[len(own)-1].T
	}
	for i := range own {
		own[i].Book = ""
	}
	writeJSON(w, map[string]any{
		"latest":   latest,
		"series":   series,
		"own":      own,
		"book":     book,
		"bookTime": bookTime,
	}, nil)
}

func (s *Server) doc(w http.ResponseWriter, r *http.Request) {
	t, body, err := s.App.Store.Doc(r.PathValue("kind"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if body == "" {
		http.Error(w, "нет данных: синк ещё не отработал", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Fetched-At", strconv.FormatInt(t.Unix(), 10))
	w.Write([]byte(body))
}

// sync запускает синк вручную из интерфейса.
func (s *Server) sync(w http.ResponseWriter, r *http.Request) {
	// Контекст запроса закроется раньше синка, поэтому фоновый.
	go func() {
		s.App.SyncPriceTable(context.Background())
		s.App.SyncDocs(context.Background())
	}()
	writeJSON(w, map[string]string{"ok": "started"}, nil)
}
