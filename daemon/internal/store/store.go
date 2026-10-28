// Package store хранит историю рынка в SQLite рядом с exe.
package store

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	DB *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS snapshots (
	item_id INTEGER NOT NULL,
	t       INTEGER NOT NULL,
	min     INTEGER NOT NULL,
	median  INTEGER NOT NULL,
	qty     INTEGER NOT NULL,
	PRIMARY KEY (item_id, t)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS latest (
	item_id  INTEGER PRIMARY KEY,
	t        INTEGER NOT NULL,
	min      INTEGER NOT NULL,
	median   INTEGER NOT NULL,
	qty      INTEGER NOT NULL,
	median7  INTEGER NOT NULL,
	median30 INTEGER NOT NULL,
	low30    INTEGER NOT NULL,
	high30   INTEGER NOT NULL,
	sales10  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS own_scans (
	item_id INTEGER NOT NULL,
	t       INTEGER NOT NULL,
	min     INTEGER NOT NULL,
	qty     INTEGER NOT NULL,
	book    TEXT NOT NULL,
	PRIMARY KEY (item_id, t)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS items (
	item_id INTEGER PRIMARY KEY,
	name    TEXT NOT NULL,
	-- name в нижнем регистре: LIKE в SQLite не умеет без учёта регистра для кириллицы.
	name_lc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS snapshots_t ON snapshots (t);
CREATE INDEX IF NOT EXISTS own_scans_t ON own_scans (t);

CREATE TABLE IF NOT EXISTS docs (
	kind TEXT PRIMARY KEY,
	t    INTEGER NOT NULL,
	body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	// SQLite пишет из одного соединения; так проще и без блокировок.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	return &Store{DB: db}, nil
}

func (s *Store) Close() error { return s.DB.Close() }

// PriceRow это строка таблицы AHledger в момент t.
type PriceRow struct {
	ItemID                                             int64
	Min, Median, Qty, Median7, Median30, Low30, High30 int64
	Sales10                                            int64
}

// SavePriceTable пишет снимок рынка. Повторный снимок с тем же временем не дублируется.
func (s *Store) SavePriceTable(t time.Time, rows []PriceRow) (bool, error) {
	unix := t.Unix()
	var exists int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM snapshots WHERE t = ? LIMIT 1`, unix).Scan(&exists); err != nil {
		return false, err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	snap, err := tx.Prepare(`INSERT OR IGNORE INTO snapshots (item_id, t, min, median, qty) VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		return false, err
	}
	latest, err := tx.Prepare(`INSERT INTO latest (item_id, t, min, median, qty, median7, median30, low30, high30, sales10)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(item_id) DO UPDATE SET t=excluded.t, min=excluded.min, median=excluded.median, qty=excluded.qty,
			median7=excluded.median7, median30=excluded.median30, low30=excluded.low30, high30=excluded.high30, sales10=excluded.sales10
		WHERE excluded.t >= latest.t`)
	if err != nil {
		return false, err
	}
	for _, r := range rows {
		if exists == 0 && (r.Min > 0 || r.Median > 0) {
			if _, err := snap.Exec(r.ItemID, unix, r.Min, r.Median, r.Qty); err != nil {
				return false, err
			}
		}
		if _, err := latest.Exec(r.ItemID, unix, r.Min, r.Median, r.Qty, r.Median7, r.Median30, r.Low30, r.High30, r.Sales10); err != nil {
			return false, err
		}
	}
	return exists == 0, tx.Commit()
}

// OwnScanItem это строка стакана из своего скана.
type OwnScanItem struct {
	ItemID   int64
	Min, Qty int64
	Book     string
}

func (s *Store) SaveOwnScan(t time.Time, items []OwnScanItem) (bool, error) {
	unix := t.Unix()
	var exists int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM own_scans WHERE t = ? LIMIT 1`, unix).Scan(&exists); err != nil {
		return false, err
	}
	if exists > 0 {
		return false, nil
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	st, err := tx.Prepare(`INSERT OR IGNORE INTO own_scans (item_id, t, min, qty, book) VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		return false, err
	}
	for _, it := range items {
		if _, err := st.Exec(it.ItemID, unix, it.Min, it.Qty, it.Book); err != nil {
			return false, err
		}
	}
	return true, tx.Commit()
}

func (s *Store) SaveNames(names map[int64]string) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	st, err := tx.Prepare(`INSERT INTO items (item_id, name, name_lc) VALUES (?, ?, ?)
		ON CONFLICT(item_id) DO UPDATE SET name=excluded.name, name_lc=excluded.name_lc`)
	if err != nil {
		return err
	}
	for id, name := range names {
		if _, err := st.Exec(id, name, strings.ToLower(name)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SaveDoc хранит последний ответ JSON-эндпоинта (сделки, сигналы и т.п.) как есть.
func (s *Store) SaveDoc(kind string, t time.Time, body []byte) error {
	_, err := s.DB.Exec(`INSERT INTO docs (kind, t, body) VALUES (?, ?, ?)
		ON CONFLICT(kind) DO UPDATE SET t=excluded.t, body=excluded.body`, kind, t.Unix(), string(body))
	return err
}

func (s *Store) Doc(kind string) (time.Time, string, error) {
	var unix int64
	var body string
	err := s.DB.QueryRow(`SELECT t, body FROM docs WHERE kind = ?`, kind).Scan(&unix, &body)
	if err == sql.ErrNoRows {
		return time.Time{}, "", nil
	}
	return time.Unix(unix, 0), body, err
}

func (s *Store) SetMeta(key, value string) error {
	_, err := s.DB.Exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

func (s *Store) Meta(key string) string {
	var v string
	s.DB.QueryRow(`SELECT value FROM meta WHERE key = ?`, key).Scan(&v)
	return v
}

// UseMarket привязывает базу к рынку AHledger. Если рынок в config.json сменился,
// цены и документы старого рынка удаляются, чтобы графики не смешивали два аукциона.
// Свои сканы аддона не трогаем: они приходят с того рынка, где играешь.
func (s *Store) UseMarket(market string) error {
	if s.Meta("market") == market {
		return nil
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{`DELETE FROM snapshots`, `DELETE FROM latest`, `DELETE FROM docs`} {
		if _, err := tx.Exec(q); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`INSERT INTO meta (key, value) VALUES ('market', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, market); err != nil {
		return err
	}
	return tx.Commit()
}

// Compact прореживает историю: старше 7 дней одна точка в час, старше 30 дней одна в день.
// Оставляется первая точка каждого интервала.
func (s *Store) Compact(now time.Time) error {
	for _, step := range []struct {
		olderThan time.Duration
		bucket    int64
	}{
		{7 * 24 * time.Hour, 3600},
		{30 * 24 * time.Hour, 86400},
	} {
		cutoff := now.Add(-step.olderThan).Unix()
		for _, table := range []string{"snapshots", "own_scans"} {
			q := fmt.Sprintf(`DELETE FROM %[1]s WHERE t < ? AND t NOT IN (
				SELECT MIN(t) FROM %[1]s WHERE t < ? GROUP BY t / ?)`, table)
			if _, err := s.DB.Exec(q, cutoff, cutoff, step.bucket); err != nil {
				return err
			}
		}
	}
	return nil
}

type Point struct {
	T      int64 `json:"t"`
	Min    int64 `json:"min"`
	Median int64 `json:"median"`
	Qty    int64 `json:"qty"`
}

func (s *Store) Series(itemID int64, since time.Time) ([]Point, error) {
	rows, err := s.DB.Query(`SELECT t, min, median, qty FROM snapshots WHERE item_id = ? AND t >= ? ORDER BY t`, itemID, since.Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Point
	for rows.Next() {
		var p Point
		if err := rows.Scan(&p.T, &p.Min, &p.Median, &p.Qty); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

type OwnPoint struct {
	T    int64  `json:"t"`
	Min  int64  `json:"min"`
	Qty  int64  `json:"qty"`
	Book string `json:"book,omitempty"`
}

func (s *Store) OwnSeries(itemID int64, since time.Time) ([]OwnPoint, error) {
	rows, err := s.DB.Query(`SELECT t, min, qty, book FROM own_scans WHERE item_id = ? AND t >= ? ORDER BY t`, itemID, since.Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OwnPoint
	for rows.Next() {
		var p OwnPoint
		if err := rows.Scan(&p.T, &p.Min, &p.Qty, &p.Book); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

type Latest struct {
	ItemID   int64  `json:"itemId"`
	Name     string `json:"name"`
	T        int64  `json:"t"`
	Min      int64  `json:"min"`
	Median   int64  `json:"median"`
	Qty      int64  `json:"qty"`
	Median7  int64  `json:"median7"`
	Median30 int64  `json:"median30"`
	Low30    int64  `json:"low30"`
	High30   int64  `json:"high30"`
	Sales10  int64  `json:"sales10"`
}

const latestCols = `l.item_id, COALESCE(i.name, ''), l.t, l.min, l.median, l.qty, l.median7, l.median30, l.low30, l.high30, l.sales10`

func scanLatest(rows *sql.Rows) ([]Latest, error) {
	defer rows.Close()
	var out []Latest
	for rows.Next() {
		var l Latest
		if err := rows.Scan(&l.ItemID, &l.Name, &l.T, &l.Min, &l.Median, &l.Qty, &l.Median7, &l.Median30, &l.Low30, &l.High30, &l.Sales10); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (s *Store) LatestItem(itemID int64) (*Latest, error) {
	rows, err := s.DB.Query(`SELECT `+latestCols+` FROM latest l LEFT JOIN items i ON i.item_id = l.item_id WHERE l.item_id = ?`, itemID)
	if err != nil {
		return nil, err
	}
	list, err := scanLatest(rows)
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return &list[0], nil
}

// Search ищет по названию или номеру предмета, самые ликвидные сверху.
func (s *Store) Search(q string, limit int) ([]Latest, error) {
	q = strings.TrimSpace(q)
	where, args := "1=1", []any{}
	if q != "" {
		where = "(CAST(l.item_id AS TEXT) = ? OR i.name_lc LIKE ?)"
		args = append(args, q, "%"+strings.ToLower(q)+"%")
	}
	args = append(args, limit)
	rows, err := s.DB.Query(`SELECT `+latestCols+` FROM latest l LEFT JOIN items i ON i.item_id = l.item_id
		WHERE `+where+` ORDER BY l.sales10 DESC, l.qty DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	return scanLatest(rows)
}

// Movers: ликвидные предметы, у которых текущий минимум дальше всего от медианы за 7 дней.
func (s *Store) Movers(minSales10 int64, limit int) ([]Latest, error) {
	rows, err := s.DB.Query(`SELECT `+latestCols+` FROM latest l LEFT JOIN items i ON i.item_id = l.item_id
		WHERE l.sales10 >= ? AND l.median7 > 0 AND l.min > 0
		ORDER BY ABS(CAST(l.min AS REAL) / l.median7 - 1) DESC LIMIT ?`, minSales10, limit)
	if err != nil {
		return nil, err
	}
	return scanLatest(rows)
}

func (s *Store) Counts() (map[string]int64, error) {
	out := map[string]int64{}
	for _, table := range []string{"snapshots", "latest", "own_scans", "items"} {
		var n int64
		if err := s.DB.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
			return nil, err
		}
		out[table] = n
	}
	return out, nil
}
