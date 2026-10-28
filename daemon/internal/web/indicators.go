package web

import (
	"math"
	"sort"
	"time"

	"github.com/fexolm/forevergold/daemon/internal/store"
)

// Ind: индикаторы предмета для терминала. Доли, не проценты; nil = данных не хватает.
// Формулы и пороги описаны в docs/terminal-spec.md.
type Ind struct {
	Discount   *float64 `json:"discount"`
	Z          *float64 `json:"z"`
	RangePos   *float64 `json:"rangePos"`
	DOS        *float64 `json:"dos"`
	Momentum   *float64 `json:"momentum"`
	Volatility *float64 `json:"volatility"`
	Liquidity  *float64 `json:"liquidity"`
	Change24h  *float64 `json:"change24h"`
	HistDays   float64  `json:"histDays"`
}

func f(v float64) *float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return nil
	}
	return &v
}

// pt: точка истории для индикаторов (из истории AHledger или своих снимков).
type pt struct {
	T           int64
	Min, Median float64
	Daily       bool
}

// points собирает дневную историю AHledger, часовую/по сканам и свои снимки в один ряд.
func points(hist []store.HistRow, snaps []store.Point) []pt {
	out := make([]pt, 0, len(hist)+len(snaps))
	for _, h := range hist {
		out = append(out, pt{h.T, float64(h.Min), float64(h.Median), h.Res == 86400})
	}
	for _, s := range snaps {
		out = append(out, pt{s.T, float64(s.Min), float64(s.Median), false})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].T < out[j].T })
	return out
}

// dailyMedians: медиана за каждый день UTC. Дневная точка AHledger главнее, иначе медиана внутридневных.
func dailyMedians(ps []pt) []float64 {
	daily := map[int64]float64{}
	intra := map[int64][]float64{}
	for _, p := range ps {
		if p.Median <= 0 {
			continue
		}
		day := p.T / 86400
		if p.Daily {
			daily[day] = p.Median
		} else {
			intra[day] = append(intra[day], p.Median)
		}
	}
	for day, vs := range intra {
		if _, ok := daily[day]; !ok {
			daily[day] = median(vs)
		}
	}
	days := make([]int64, 0, len(daily))
	for d := range daily {
		days = append(days, d)
	}
	sort.Slice(days, func(i, j int) bool { return days[i] < days[j] })
	out := make([]float64, len(days))
	for i, d := range days {
		out[i] = daily[d]
	}
	return out
}

func median(vs []float64) float64 {
	if len(vs) == 0 {
		return 0
	}
	s := append([]float64(nil), vs...)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

func computeInd(l store.Latest, ps []pt) Ind {
	var ind Ind
	min, med := float64(l.Min), float64(l.Median)
	daily := dailyMedians(ps)
	if len(daily) > 30 {
		daily = daily[len(daily)-30:]
	}
	if len(ps) > 0 {
		ind.HistDays = float64(ps[len(ps)-1].T-ps[0].T) / 86400
	}

	m30 := float64(l.Median30)
	if m30 <= 0 && len(daily) >= 3 {
		m30 = median(daily)
	}
	if min > 0 && m30 > 0 {
		ind.Discount = f(1 - min/m30)
	}
	if len(daily) >= 7 && min > 0 {
		c := median(daily)
		dev := make([]float64, len(daily))
		for i, v := range daily {
			dev[i] = math.Abs(v - c)
		}
		if mad := median(dev); mad > 0 {
			ind.Z = f((min - c) / (1.4826 * mad))
		}
	}
	lo, hi := float64(l.Low30), float64(l.High30)
	if (lo <= 0 || hi <= lo) && len(daily) >= 3 {
		lo, hi = daily[0], daily[0]
		for _, v := range daily {
			lo, hi = math.Min(lo, v), math.Max(hi, v)
		}
	}
	if min > 0 && hi > lo {
		ind.RangePos = f((min - lo) / (hi - lo))
	}
	sales := float64(l.Sales10) / 10
	if sales > 0 {
		ind.DOS = f(float64(l.Qty) / sales)
	}
	if l.Median7 > 0 && l.Median30 > 0 {
		ind.Momentum = f(float64(l.Median7)/float64(l.Median30) - 1)
	}
	if n := len(daily); n >= 6 {
		from := n - 15
		if from < 0 {
			from = 0
		}
		var rets []float64
		for i := from + 1; i < n; i++ {
			if daily[i-1] > 0 && daily[i] > 0 {
				rets = append(rets, math.Log(daily[i]/daily[i-1]))
			}
		}
		if len(rets) >= 5 {
			ind.Volatility = f(stddev(rets))
		}
	}
	ref := m30
	if ref <= 0 {
		ref = med
	}
	if sales > 0 && ref > 0 {
		gold := sales * ref / 10000
		ind.Liquidity = f(math.Min(100, 25*math.Log10(1+gold)))
	}
	ind.Change24h = change24h(l, ps)
	return ind
}

// change24h: изменение медианы к точке примерно сутки назад от последнего снимка.
func change24h(l store.Latest, ps []pt) *float64 {
	if l.Median <= 0 || len(ps) == 0 {
		return nil
	}
	target := l.T - 86400
	best, bestD := pt{}, int64(math.MaxInt64)
	for _, p := range ps {
		if p.Median <= 0 || p.T > l.T-12*3600 {
			continue
		}
		d := p.T - target
		if d < 0 {
			d = -d
		}
		if d < bestD {
			best, bestD = p, d
		}
	}
	if bestD > 12*3600 {
		return nil
	}
	return f(float64(l.Median)/best.Median - 1)
}

func stddev(vs []float64) float64 {
	var sum float64
	for _, v := range vs {
		sum += v
	}
	mean := sum / float64(len(vs))
	var ss float64
	for _, v := range vs {
		ss += (v - mean) * (v - mean)
	}
	return math.Sqrt(ss / float64(len(vs)-1))
}

// spark: почасовая медиана за 7 дней (из истории AHledger, иначе из своих снимков).
func spark(hist []store.HistRow, snaps []store.Point, now time.Time) [][2]int64 {
	since := now.Add(-7 * 24 * time.Hour).Unix()
	out := [][2]int64{}
	for _, h := range hist {
		if h.Res == 3600 && h.T >= since && h.Median > 0 {
			out = append(out, [2]int64{h.T, h.Median})
		}
	}
	last := int64(0)
	if len(out) > 0 {
		last = out[len(out)-1][0]
	}
	for _, s := range snaps {
		if s.T > last+1800 && s.T >= since && s.Median > 0 {
			out = append(out, [2]int64{s.T, s.Median})
			last = s.T
		}
	}
	return out
}
