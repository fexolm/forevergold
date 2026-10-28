package web

import (
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/fexolm/forevergold/daemon/internal/predict"
	"github.com/fexolm/forevergold/daemon/internal/store"
)

const (
	forecastHistory = 28 * 24 * time.Hour
	ahCut           = 0.05
)

func (s *Server) buildForecast(itemID int64, horizon time.Duration) (predict.Forecast, error) {
	now := time.Now()
	series, err := s.App.Store.Series(itemID, now.Add(-forecastHistory))
	if err != nil {
		return predict.Forecast{}, err
	}
	hist := make([]predict.Sample, 0, len(series))
	for _, p := range series {
		// Прогнозируем минимальную цену: по ней покупаем сейчас и около неё же выставляем при продаже.
		// Сравнивать текущий минимум с медианой нельзя: минимум всегда ниже, и «выгода» была бы у всех.
		price := p.Min
		if price == 0 {
			price = p.Median
		}
		hist = append(hist, predict.Sample{T: time.Unix(p.T, 0), Price: float64(price)})
	}
	return predict.Build(hist, now, horizon, time.Hour), nil
}

func (s *Server) forecast(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	f, err := s.buildForecast(id, 7*24*time.Hour)
	writeJSON(w, f, err)
}

// Opportunity: предмет, минимальная цена которого по прогнозу в ближайшие дни заметно выше нынешней.
type Opportunity struct {
	store.Latest
	// SellAt: когда по прогнозу цена будет максимальной в горизонте; SellMid: прогноз на тот момент.
	SellAt  int64   `json:"sellAt"`
	SellMid float64 `json:"sellMid"`
	SellLow float64 `json:"sellLow"`
	// Gain: ожидаемая доходность покупки по текущему минимуму с продажей в SellAt после комиссии.
	Gain        float64      `json:"gain"`
	TrendPerDay float64      `json:"trendPerDay"`
	Volatility  float64      `json:"volatility"`
	Cheapest    predict.Slot `json:"cheapest"`
}

type oppCache struct {
	mu   sync.Mutex
	at   time.Time
	list []Opportunity
}

func (s *Server) opportunities(w http.ResponseWriter, r *http.Request) {
	s.opps.mu.Lock()
	defer s.opps.mu.Unlock()
	if time.Since(s.opps.at) < 10*time.Minute && s.opps.list != nil {
		writeJSON(w, s.opps.list, nil)
		return
	}
	// Только ликвидные: от 1 продажи в день, самые продаваемые 400 предметов.
	candidates, err := s.App.Store.Liquid(10, 400)
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	list := []Opportunity{}
	for _, l := range candidates {
		if l.Min <= 0 {
			continue
		}
		f, err := s.buildForecast(l.ItemID, 3*24*time.Hour)
		if err != nil {
			writeJSON(w, nil, err)
			return
		}
		if !f.OK || len(f.Points) == 0 {
			continue
		}
		best := f.Points[0]
		for _, p := range f.Points {
			if p.Mid > best.Mid {
				best = p
			}
		}
		gain := best.Mid*(1-ahCut)/float64(l.Min) - 1
		if gain < 0.1 {
			continue
		}
		list = append(list, Opportunity{
			Latest: l, SellAt: best.T, SellMid: best.Mid, SellLow: best.Low, Gain: gain,
			TrendPerDay: f.TrendPerDay, Volatility: f.Volatility, Cheapest: f.CheapestSlot,
		})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Gain > list[j].Gain })
	if len(list) > 100 {
		list = list[:100]
	}
	s.opps.at, s.opps.list = time.Now(), list
	writeJSON(w, list, nil)
}
