package web

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/fexolm/forevergold/daemon/internal/store"
)

func TestComputeInd(t *testing.T) {
	// 30 дней с медианой около 100 и одним выбросом; текущий минимум 70.
	var hist []store.HistRow
	day := int64(1_800_000_000 / 86400 * 86400)
	for i := 0; i < 30; i++ {
		m := int64(100 + (i%3-1)*4)
		if i == 10 {
			m = 300
		}
		hist = append(hist, store.HistRow{T: day + int64(i)*86400, Res: 86400, Min: m - 10, Median: m})
	}
	last := day + 29*86400
	snaps := []store.Point{{T: last - 86400 + 600, Min: 90, Median: 100}}
	l := store.Latest{T: last + 3600, Min: 70, Median: 110, Qty: 300, Median7: 110, Median30: 100, Low30: 60, High30: 160, Sales10: 600}
	ind := computeInd(l, points(hist, snaps))

	near := func(name string, got *float64, want float64) {
		t.Helper()
		if got == nil || math.Abs(*got-want) > 1e-6 {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}
	near("discount", ind.Discount, 0.3)
	near("rangePos", ind.RangePos, 0.1)
	near("dos", ind.DOS, 5)
	near("momentum", ind.Momentum, 0.1)
	near("change24h", ind.Change24h, 0.1)
	if ind.Z == nil || *ind.Z > -2 {
		t.Errorf("z = %v, want strongly negative despite the 300 outlier", ind.Z)
	}
	if ind.Volatility == nil || *ind.Volatility <= 0 {
		t.Errorf("volatility = %v", ind.Volatility)
	}
	if ind.Liquidity == nil || *ind.Liquidity <= 0 || *ind.Liquidity > 100 {
		t.Errorf("liquidity = %v", ind.Liquidity)
	}
	if ind.HistDays < 29 {
		t.Errorf("histDays = %v", ind.HistDays)
	}
}

func TestComputeIndThinData(t *testing.T) {
	// Один снимок и нет продаж: индикаторы, которым не хватает данных, пустые, а не нули.
	l := store.Latest{T: 1_800_000_000, Min: 50, Median: 60, Qty: 10}
	ind := computeInd(l, points(nil, []store.Point{{T: l.T, Min: 50, Median: 60}}))
	for name, v := range map[string]*float64{"discount": ind.Discount, "z": ind.Z, "dos": ind.DOS, "volatility": ind.Volatility, "liquidity": ind.Liquidity, "change24h": ind.Change24h} {
		if v != nil {
			t.Errorf("%s = %v, want nil", name, *v)
		}
	}
}

func TestAddRuNames(t *testing.T) {
	var doc any
	json.Unmarshal([]byte(`{"signals":[{"item":{"id":2589,"name":"Linen Cloth"}},{"item":{"id":1,"name":"X"}}],"filters":{"id":2589}}`), &doc)
	addRuNames(doc, map[int64]string{2589: "Льняная ткань"})
	out, _ := json.Marshal(doc)
	var back struct {
		Signals []struct {
			Item struct {
				RuName string `json:"ruName"`
			} `json:"item"`
		} `json:"signals"`
		Filters map[string]any `json:"filters"`
	}
	json.Unmarshal(out, &back)
	if back.Signals[0].Item.RuName != "Льняная ткань" || back.Signals[1].Item.RuName != "" {
		t.Errorf("ruName not injected correctly: %s", out)
	}
	if _, ok := back.Filters["ruName"]; ok {
		t.Errorf("objects without a name must not get ruName: %s", out)
	}
}
