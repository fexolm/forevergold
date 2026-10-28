package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestNamesAndHistory(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.migrate(); err != nil {
		t.Fatalf("migrations must be re-runnable: %v", err)
	}
	now := time.Unix(1_800_000_000, 0)
	if _, err := st.SavePriceTable(now, []PriceRow{{ItemID: 1, Min: 10, Median: 12}, {ItemID: 2, Min: 20, Median: 22}}); err != nil {
		t.Fatal(err)
	}

	l, _ := st.LatestItem(1)
	if l.Name != "Предмет #1" {
		t.Errorf("name without any source = %q", l.Name)
	}
	st.SaveMeta([]Meta{{ItemID: 1, NameEn: "Linen Cloth", Quality: "COMMON"}, {ItemID: 2, NameEn: "Wool Cloth"}})
	l, _ = st.LatestItem(1)
	if l.Name != "Linen Cloth" || l.Quality != "COMMON" {
		t.Errorf("English fallback: %+v", l)
	}
	st.SaveRuName(1, "Льняная ткань")
	st.SaveNames(map[int64]string{2: "Шерстяная ткань (аддон)"})
	st.SaveRuName(2, "Шерстяная ткань")
	if l, _ = st.LatestItem(1); l.Name != "Льняная ткань" {
		t.Errorf("Wowhead name: %q", l.Name)
	}
	if l, _ = st.LatestItem(2); l.Name != "Шерстяная ткань (аддон)" {
		t.Errorf("addon name must win over Wowhead: %q", l.Name)
	}
	if ids, _ := st.MissingRu(10); len(ids) != 0 {
		t.Errorf("MissingRu = %v", ids)
	}
	if found, _ := st.Search("льнян", 10); len(found) != 1 || found[0].ItemID != 1 {
		t.Errorf("search by Russian name: %+v", found)
	}
	if found, _ := st.Search("wool", 10); len(found) != 1 || found[0].ItemID != 2 {
		t.Errorf("search by English name: %+v", found)
	}

	rows := []HistRow{{T: now.Unix() - 86400, Res: 86400, Min: 9, Median: 11}, {T: now.Unix() - 3600, Res: 3600, Min: 10, Median: 12}}
	if err := st.SaveHist(1, "30d", rows); err != nil {
		t.Fatal(err)
	}
	if time.Since(st.HistFetched(1, "30d")) > time.Minute {
		t.Error("fetch time not recorded")
	}
	daily, _ := st.Hist(1, 86400, now.Add(-48*time.Hour))
	all, _ := st.Hist(1, -1, now.Add(-48*time.Hour))
	if len(daily) != 1 || len(all) != 2 {
		t.Errorf("hist filter by step: daily %d, all %d", len(daily), len(all))
	}
	if err := st.UseMarket("other"); err != nil {
		t.Fatal(err)
	}
	if all, _ = st.Hist(1, -1, time.Unix(0, 0)); len(all) != 0 {
		t.Error("history of the old market must be dropped on market change")
	}
}
