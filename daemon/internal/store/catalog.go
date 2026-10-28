package store

import (
	"fmt"
	"strings"
	"time"
)

// Колонки, добавленные после первой версии базы. ALTER TABLE на уже обновлённой базе
// падает с "duplicate column", это нормально.
var migrations = []string{
	`ALTER TABLE items ADD COLUMN name_src TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE items ADD COLUMN name_en TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE items ADD COLUMN quality TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE items ADD COLUMN icon TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE items ADD COLUMN class TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE items ADD COLUMN subclass TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE items ADD COLUMN level INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE items ADD COLUMN vendor_sell INTEGER NOT NULL DEFAULT -1`,
	`ALTER TABLE items ADD COLUMN meta_t INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE items ADD COLUMN ru_tried INTEGER NOT NULL DEFAULT 0`,
	// hist: история AHledger по предмету (/v1/prices). Дневные и часовые точки лежат вместе:
	// у дневных t в полночь UTC, у часовых в начале часа, у 24h во время скана.
	`CREATE TABLE IF NOT EXISTS hist (
		item_id  INTEGER NOT NULL,
		t        INTEGER NOT NULL,
		res      INTEGER NOT NULL,
		min      INTEGER NOT NULL,
		median   INTEGER NOT NULL,
		p25      INTEGER NOT NULL,
		p75      INTEGER NOT NULL,
		qty      INTEGER NOT NULL,
		auctions INTEGER NOT NULL,
		PRIMARY KEY (item_id, t, res)
	) WITHOUT ROWID`,
	`CREATE TABLE IF NOT EXISTS hist_fetch (
		item_id INTEGER NOT NULL,
		rng     TEXT NOT NULL,
		t       INTEGER NOT NULL,
		PRIMARY KEY (item_id, rng)
	) WITHOUT ROWID`,
	// Предметы, которых Wowhead не знал, переспрашиваем при каждом запуске: база там пополняется.
	`UPDATE items SET ru_tried = 0 WHERE name = ''`,
}

func (s *Store) migrate() error {
	for _, q := range migrations {
		if _, err := s.DB.Exec(q); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return fmt.Errorf("migrate %q: %w", q[:40], err)
		}
	}
	return nil
}

// Meta это справка о предмете: названия, качество, иконка, класс.
type Meta struct {
	ItemID       int64  `json:"itemId"`
	Name         string `json:"name"`
	NameEn       string `json:"nameEn"`
	Quality      string `json:"quality"`
	Icon         string `json:"icon"`
	ItemClass    string `json:"itemClass"`
	ItemSubclass string `json:"itemSubclass,omitempty"`
	Level        int64  `json:"level,omitempty"`
	VendorSell   int64  `json:"vendorSell"`
}

// displayName: русское название, иначе английское, иначе номер. Никогда не пусто.
const displayName = `COALESCE(NULLIF(i.name, ''), NULLIF(i.name_en, ''), 'Предмет #' || %s)`

func (s *Store) ItemMeta(id int64) (Meta, error) {
	m := Meta{ItemID: id, VendorSell: -1}
	err := s.DB.QueryRow(`SELECT `+fmt.Sprintf(displayName, "i.item_id")+`, i.name_en, i.quality, i.icon, i.class, i.subclass, i.level, i.vendor_sell
		FROM items i WHERE i.item_id = ?`, id).Scan(&m.Name, &m.NameEn, &m.Quality, &m.Icon, &m.ItemClass, &m.ItemSubclass, &m.Level, &m.VendorSell)
	if err != nil {
		m.Name = fmt.Sprintf("Предмет #%d", id)
		return m, nil
	}
	return m, nil
}

// MissingMeta: предметы с ценами, для которых ещё нет справки AHledger.
func (s *Store) MissingMeta(limit int) ([]int64, error) {
	return s.ids(`SELECT l.item_id FROM latest l LEFT JOIN items i ON i.item_id = l.item_id
		WHERE i.item_id IS NULL OR i.meta_t = 0 ORDER BY l.sales10 DESC LIMIT ?`, limit)
}

// MissingRu: предметы без русского названия, которые ещё не искали на Wowhead; ходовые первыми.
func (s *Store) MissingRu(limit int) ([]int64, error) {
	return s.ids(`SELECT i.item_id FROM items i LEFT JOIN latest l ON l.item_id = i.item_id
		WHERE i.name = '' AND i.ru_tried = 0 ORDER BY COALESCE(l.sales10, -1) DESC, COALESCE(l.qty, -1) DESC LIMIT ?`, limit)
}

// WantNames: предметы, чьё название ещё не приходило из клиента игры; их спрашивает аддон.
func (s *Store) WantNames(limit int) ([]int64, error) {
	return s.ids(`SELECT item_id FROM items WHERE name_src <> 'addon' ORDER BY item_id LIMIT ?`, limit)
}

// SaveDocNames заводит предметы из документов AHledger (результаты рецептов, реагенты и т.п.)
// с английским названием, чтобы для них тоже искались русские.
func (s *Store) SaveDocNames(names map[int64]string) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	st, err := tx.Prepare(`INSERT INTO items (item_id, name, name_lc, name_en) VALUES (?, '', '', ?)
		ON CONFLICT(item_id) DO UPDATE SET name_en = CASE WHEN items.name_en = '' THEN excluded.name_en ELSE items.name_en END`)
	if err != nil {
		return err
	}
	for id, name := range names {
		if _, err := st.Exec(id, name); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ids(q string, args ...any) ([]int64, error) {
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// SaveMeta пишет справку AHledger, не трогая русское название.
func (s *Store) SaveMeta(list []Meta) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	st, err := tx.Prepare(`INSERT INTO items (item_id, name, name_lc, name_en, quality, icon, class, level, meta_t)
		VALUES (?, '', '', ?, ?, ?, ?, ?, ?)
		ON CONFLICT(item_id) DO UPDATE SET name_en=excluded.name_en, quality=excluded.quality, icon=excluded.icon,
			class=excluded.class, level=excluded.level, meta_t=excluded.meta_t`)
	if err != nil {
		return err
	}
	now := time.Now().Unix()
	for _, m := range list {
		if _, err := st.Exec(m.ItemID, m.NameEn, m.Quality, m.Icon, m.ItemClass, m.Level, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SaveItemInfo дописывает подкласс и цену у вендора (их нет в пакетной справке).
func (s *Store) SaveItemInfo(id int64, subclass string, vendorSell int64) error {
	_, err := s.DB.Exec(`INSERT INTO items (item_id, name, name_lc, subclass, vendor_sell) VALUES (?, '', '', ?, ?)
		ON CONFLICT(item_id) DO UPDATE SET subclass=excluded.subclass, vendor_sell=excluded.vendor_sell`, id, subclass, vendorSell)
	return err
}

// SaveRuName пишет русское название с Wowhead. Название из аддона главнее и не перезаписывается.
func (s *Store) SaveRuName(id int64, name string) error {
	_, err := s.DB.Exec(`INSERT INTO items (item_id, name, name_lc, name_src, ru_tried) VALUES (?, ?, ?, 'wowhead', 1)
		ON CONFLICT(item_id) DO UPDATE SET ru_tried=1,
			name=CASE WHEN items.name_src = 'addon' AND items.name <> '' THEN items.name ELSE excluded.name END,
			name_lc=CASE WHEN items.name_src = 'addon' AND items.name <> '' THEN items.name_lc ELSE excluded.name_lc END,
			name_src=CASE WHEN items.name_src = 'addon' AND items.name <> '' THEN 'addon' ELSE 'wowhead' END`,
		id, name, strings.ToLower(name))
	return err
}

// RuNames: все известные русские названия.
func (s *Store) RuNames() (map[int64]string, error) {
	rows, err := s.DB.Query(`SELECT item_id, name FROM items WHERE name <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

// HistRow это точка истории AHledger. Res: шаг в секундах (0 = скан, 3600 = час, 86400 = день).
type HistRow struct {
	T        int64 `json:"t"`
	Res      int64 `json:"-"`
	Min      int64 `json:"min"`
	Median   int64 `json:"median"`
	P25      int64 `json:"p25"`
	P75      int64 `json:"p75"`
	Qty      int64 `json:"qty"`
	Auctions int64 `json:"auctions"`
}

func (s *Store) SaveHist(id int64, rng string, rows []HistRow) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	st, err := tx.Prepare(`INSERT INTO hist (item_id, t, res, min, median, p25, p75, qty, auctions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(item_id, t, res) DO UPDATE SET min=excluded.min, median=excluded.median, p25=excluded.p25,
			p75=excluded.p75, qty=excluded.qty, auctions=excluded.auctions`)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if _, err := st.Exec(id, r.T, r.Res, r.Min, r.Median, r.P25, r.P75, r.Qty, r.Auctions); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`INSERT INTO hist_fetch (item_id, rng, t) VALUES (?, ?, ?)
		ON CONFLICT(item_id, rng) DO UPDATE SET t=excluded.t`, id, rng, time.Now().Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

// HistFetched: когда историю предмета с этим шагом последний раз скачивали.
func (s *Store) HistFetched(id int64, rng string) time.Time {
	var t int64
	s.DB.QueryRow(`SELECT t FROM hist_fetch WHERE item_id = ? AND rng = ?`, id, rng).Scan(&t)
	return time.Unix(t, 0)
}

// Hist отдаёт точки с шагом res (или все, если res < 0) начиная с since.
func (s *Store) Hist(id int64, res int64, since time.Time) ([]HistRow, error) {
	m, err := s.HistBulk([]int64{id}, res, since)
	return m[id], err
}

func (s *Store) HistBulk(ids []int64, res int64, since time.Time) (map[int64][]HistRow, error) {
	out := map[int64][]HistRow{}
	if len(ids) == 0 {
		return out, nil
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids)+2)
	for _, id := range ids {
		args = append(args, id)
	}
	args = append(args, since.Unix(), res)
	rows, err := s.DB.Query(`SELECT item_id, t, res, min, median, p25, p75, qty, auctions FROM hist
		WHERE item_id IN (`+ph+`) AND t >= ? AND (? < 0 OR res = ?) ORDER BY item_id, t`, append(args, res)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var r HistRow
		if err := rows.Scan(&id, &r.T, &r.Res, &r.Min, &r.Median, &r.P25, &r.P75, &r.Qty, &r.Auctions); err != nil {
			return nil, err
		}
		out[id] = append(out[id], r)
	}
	return out, rows.Err()
}

// SeriesBulk: свои снимки таблицы цен для нескольких предметов.
func (s *Store) SeriesBulk(ids []int64, since time.Time) (map[int64][]Point, error) {
	out := map[int64][]Point{}
	if len(ids) == 0 {
		return out, nil
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids)+1)
	for _, id := range ids {
		args = append(args, id)
	}
	args = append(args, since.Unix())
	rows, err := s.DB.Query(`SELECT item_id, t, min, median, qty FROM snapshots WHERE item_id IN (`+ph+`) AND t >= ? ORDER BY item_id, t`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var p Point
		if err := rows.Scan(&id, &p.T, &p.Min, &p.Median, &p.Qty); err != nil {
			return nil, err
		}
		out[id] = append(out[id], p)
	}
	return out, rows.Err()
}
