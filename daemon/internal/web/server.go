// Package web отдаёт локальный веб-интерфейс и JSON API для него.
package web

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"strconv"

	"github.com/fexolm/forevergold/daemon/internal/app"
)

//go:embed static
var static embed.FS

type Server struct {
	App     *app.App
	opps    oppCache
	markets marketCache
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
	mux.HandleFunc("GET /api/instruments", s.instruments)
	mux.HandleFunc("GET /api/markets", s.marketsHandler)
	mux.HandleFunc("POST /api/market", s.setMarket)
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
	market := s.App.Market()
	label, status := market, ""
	if list, err := s.marketList(r.Context()); err == nil {
		for _, m := range list {
			if m.ID == market {
				label, status = m.Label, m.Status
			}
		}
	}
	var asOf int64
	if t := s.App.Store.PricesAsOf(); !t.IsZero() {
		asOf = t.Unix()
	}
	writeJSON(w, map[string]any{
		"market":       market,
		"marketLabel":  label,
		"marketStatus": status,
		"pricesAsOf":   asOf,
		"wowPath":      s.App.Cfg.WowPath,
		"professions":  s.App.Cfg.Professions,
		"jobs":         s.App.Status(),
		"counts":       counts,
	}, err)
}

func (s *Server) movers(w http.ResponseWriter, r *http.Request) {
	// Не меньше 1 продажи в день (sales10 >= 10).
	list, err := s.App.Store.Movers(10, 50)
	writeJSON(w, list, err)
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
	var parsed any
	if names, err := s.App.Store.RuNames(); err == nil && len(names) > 0 && json.Unmarshal([]byte(body), &parsed) == nil {
		addRuNames(parsed, names)
		if b, err := json.Marshal(parsed); err == nil {
			body = string(b)
		}
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
