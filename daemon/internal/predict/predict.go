// Package predict строит простой и объяснимый прогноз цены предмета по истории снимков:
// тренд за 7 дней, профиль по часам суток и дням недели и вилку из разброса остатков.
package predict

import (
	"math"
	"sort"
	"time"
)

// Sample это одна точка истории: время и цена в меди.
type Sample struct {
	T     time.Time
	Price float64
}

type Point struct {
	T    int64   `json:"t"`
	Mid  float64 `json:"mid"`
	Low  float64 `json:"low"`
	High float64 `json:"high"`
}

type Slot struct {
	Weekday int `json:"weekday"` // 0 = воскресенье, как time.Weekday
	Hour    int `json:"hour"`
}

type Forecast struct {
	// Days: за сколько дней есть история; при < MinDays прогноз не строится.
	Days float64 `json:"days"`
	OK   bool    `json:"ok"`
	Note string  `json:"note,omitempty"`

	// TrendPerDay: изменение цены за день в долях (0.02 = +2% в день).
	TrendPerDay float64 `json:"trendPerDay"`
	// Hourly[h] и Weekday[d]: множитель к средней цене (1.05 = на 5% дороже обычного).
	Hourly  [24]float64 `json:"hourly"`
	Weekday [7]float64  `json:"weekday"`
	// Volatility: стандартное отклонение остатков в долях цены.
	Volatility float64 `json:"volatility"`

	Base   float64 `json:"base"` // текущий уровень без сезонности, медь
	Points []Point `json:"points"`

	CheapestSlot Slot `json:"cheapestSlot"`
	DearestSlot  Slot `json:"dearestSlot"`
}

const (
	MinDays = 3
	// Сколько точек в корзине нужно, чтобы доверять её множителю наполовину.
	shrinkSamples = 8
	// Вилка 80%: ±1.28 сигмы.
	z80 = 1.2816
)

// Build считает прогноз по истории на horizon вперёд с шагом step.
func Build(history []Sample, now time.Time, horizon, step time.Duration) Forecast {
	var f Forecast
	for i := range f.Hourly {
		f.Hourly[i] = 1
	}
	for i := range f.Weekday {
		f.Weekday[i] = 1
	}
	pts := make([]Sample, 0, len(history))
	for _, s := range history {
		if s.Price > 0 {
			pts = append(pts, s)
		}
	}
	if len(pts) < 10 {
		f.Note = "мало точек истории"
		return f
	}
	sort.Slice(pts, func(i, j int) bool { return pts[i].T.Before(pts[j].T) })
	f.Days = pts[len(pts)-1].T.Sub(pts[0].T).Hours() / 24
	if f.Days < MinDays {
		f.Note = "для прогноза нужно хотя бы 3 дня истории"
		return f
	}

	// 1. Тренд: МНК по логарифму цены за последние 7 дней.
	since := now.Add(-7 * 24 * time.Hour)
	var xs, ys []float64
	for _, p := range pts {
		if p.T.After(since) {
			xs = append(xs, p.T.Sub(now).Hours()/24)
			ys = append(ys, math.Log(p.Price))
		}
	}
	slope, intercept := linreg(xs, ys)
	// Тренд сильнее 10% в день на горизонте недели почти всегда шум или разовое событие: обрезаем.
	slope = clamp(slope, -0.1, 0.1)
	f.TrendPerDay = math.Exp(slope) - 1

	// 2. Сезонность. Часы суток: отклонение от среднего за ±12 часов.
	// Дни недели: отклонение среднего за сутки от среднего за ±3.5 дня.
	// Окно по суткам съедает эффект дня недели, поэтому они считаются от разных базовых линий.
	daily := make([]float64, len(pts))
	weekly := make([]float64, len(pts))
	for i := range pts {
		daily[i] = rollingMeanLog(pts, i, 12*time.Hour)
		weekly[i] = rollingMeanLog(pts, i, 84*time.Hour)
	}
	var hourSum [24]float64
	var hourN [24]int
	var daySum [7]float64
	var dayN [7]int
	for i, p := range pts {
		lt := p.T.In(now.Location())
		hourSum[lt.Hour()] += math.Log(p.Price) - daily[i]
		hourN[lt.Hour()]++
		daySum[int(lt.Weekday())] += math.Log(p.Price) - weekly[i]
		dayN[int(lt.Weekday())]++
	}
	for h := range f.Hourly {
		f.Hourly[h] = math.Exp(shrunkMean(hourSum[h], hourN[h]))
	}
	for d := range f.Weekday {
		f.Weekday[d] = math.Exp(shrunkMean(daySum[d], dayN[d]))
	}

	// 3. Разброс: остатки после недельного уровня и обоих профилей.
	var ss float64
	for i, p := range pts {
		lt := p.T.In(now.Location())
		e := math.Log(p.Price) - weekly[i] - math.Log(f.Hourly[lt.Hour()]) - math.Log(f.Weekday[int(lt.Weekday())])
		ss += e * e
	}
	f.Volatility = math.Sqrt(ss / float64(len(pts)))

	// Уровень «сейчас» без сезонности: точка тренда в момент now, а если тренд не посчитать, среднее за сутки.
	if len(xs) >= 2 {
		f.Base = math.Exp(intercept)
	} else {
		f.Base = math.Exp(rollingMeanLog(pts, len(pts)-1, 24*time.Hour))
	}

	for t := now.Add(step); !t.After(now.Add(horizon)); t = t.Add(step) {
		days := t.Sub(now).Hours() / 24
		lt := t.In(now.Location())
		mid := f.Base * math.Exp(slope*dampedDays(days)) * f.Hourly[lt.Hour()] * f.Weekday[int(lt.Weekday())]
		// Неопределённость растёт с горизонтом, но не быстрее корня из дней.
		spread := z80 * f.Volatility * math.Sqrt(1+days)
		f.Points = append(f.Points, Point{T: t.Unix(), Mid: mid, Low: mid * math.Exp(-spread), High: mid * math.Exp(spread)})
	}

	f.CheapestSlot, f.DearestSlot = extremeSlots(f.Hourly, f.Weekday)
	f.OK = true
	return f
}

// dampedDays: тренд затухает (φ = 0.7 в день), иначе недельный тренд, продолженный на неделю,
// даёт фантастические цены. Суммарно тренд действует не больше ~3.3 дня.
func dampedDays(days float64) float64 {
	const phi = 0.7
	return (1 - math.Pow(phi, days)) / (1 - phi)
}

func linreg(xs, ys []float64) (slope, intercept float64) {
	n := float64(len(xs))
	if n < 2 {
		if n == 1 {
			return 0, ys[0]
		}
		return 0, 0
	}
	var sx, sy, sxx, sxy float64
	for i := range xs {
		sx += xs[i]
		sy += ys[i]
		sxx += xs[i] * xs[i]
		sxy += xs[i] * ys[i]
	}
	d := n*sxx - sx*sx
	if d == 0 {
		return 0, sy / n
	}
	slope = (n*sxy - sx*sy) / d
	return slope, (sy - slope*sx) / n
}

func rollingMeanLog(pts []Sample, i int, half time.Duration) float64 {
	var sum float64
	var n int
	for j := i; j >= 0 && pts[i].T.Sub(pts[j].T) <= half; j-- {
		sum += math.Log(pts[j].Price)
		n++
	}
	for j := i + 1; j < len(pts) && pts[j].T.Sub(pts[i].T) <= half; j++ {
		sum += math.Log(pts[j].Price)
		n++
	}
	return sum / float64(n)
}

// shrunkMean тянет среднее к нулю, когда точек мало, чтобы редкие корзины не давали выбросов.
func shrunkMean(sum float64, n int) float64 {
	return sum / float64(n+shrinkSamples)
}

func extremeSlots(hourly [24]float64, weekday [7]float64) (cheap, dear Slot) {
	lo, hi := math.Inf(1), math.Inf(-1)
	for d := 0; d < 7; d++ {
		for h := 0; h < 24; h++ {
			v := hourly[h] * weekday[d]
			if v < lo {
				lo, cheap = v, Slot{d, h}
			}
			if v > hi {
				hi, dear = v, Slot{d, h}
			}
		}
	}
	return cheap, dear
}

func clamp(v, lo, hi float64) float64 {
	return math.Max(lo, math.Min(hi, v))
}
