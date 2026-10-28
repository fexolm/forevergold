package predict

import (
	"math"
	"math/rand"
	"testing"
	"time"
)

func TestBuildRecoversSeasonalityAndTrend(t *testing.T) {
	loc := time.UTC
	now := time.Date(2026, 12, 20, 12, 0, 0, 0, loc)
	rng := rand.New(rand.NewSource(1))
	var hist []Sample
	for ts := now.Add(-21 * 24 * time.Hour); !ts.After(now); ts = ts.Add(15 * time.Minute) {
		days := ts.Sub(now).Hours() / 24
		price := 1000 * math.Exp(0.01*days) // +1% в день
		if ts.Hour() >= 18 && ts.Hour() < 23 {
			price *= 1.2 // вечером дороже
		}
		if ts.Weekday() == time.Tuesday {
			price *= 1.1 // день рейда
		}
		price *= math.Exp(0.03 * rng.NormFloat64())
		hist = append(hist, Sample{ts, price})
	}

	f := Build(hist, now, 7*24*time.Hour, time.Hour)
	if !f.OK {
		t.Fatalf("not ok: %s", f.Note)
	}
	if math.Abs(f.TrendPerDay-0.01) > 0.01 {
		t.Errorf("trend = %.4f, want ~0.01", f.TrendPerDay)
	}
	if f.Hourly[20] < 1.08 || f.Hourly[4] > 0.99 {
		t.Errorf("hourly evening %.3f night %.3f", f.Hourly[20], f.Hourly[4])
	}
	if f.Weekday[int(time.Tuesday)] < 1.03 {
		t.Errorf("tuesday factor %.3f", f.Weekday[int(time.Tuesday)])
	}
	if f.DearestSlot.Weekday != int(time.Tuesday) || f.DearestSlot.Hour < 18 || f.DearestSlot.Hour >= 23 {
		t.Errorf("dearest slot %+v", f.DearestSlot)
	}
	if len(f.Points) != 7*24 {
		t.Fatalf("points = %d", len(f.Points))
	}
	for _, p := range f.Points {
		if !(p.Low < p.Mid && p.Mid < p.High) {
			t.Fatalf("bad band %+v", p)
		}
	}
	// Вилка должна расширяться с горизонтом.
	first, last := f.Points[0], f.Points[len(f.Points)-1]
	if (last.High / last.Mid) <= (first.High / first.Mid) {
		t.Errorf("band does not widen")
	}
}

func TestBuildNeedsHistory(t *testing.T) {
	now := time.Now()
	var hist []Sample
	for i := 0; i < 50; i++ {
		hist = append(hist, Sample{now.Add(-time.Duration(i) * time.Hour), 100})
	}
	if f := Build(hist, now, 24*time.Hour, time.Hour); f.OK {
		t.Fatal("2 days of history should not be enough")
	}
}
