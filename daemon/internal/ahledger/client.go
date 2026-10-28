// Package ahledger читает открытый API https://ahledger.com (данные AHledger, требуется указывать источник).
package ahledger

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const DefaultBaseURL = "https://api.ahledger.com"

// ErrNotModified возвращается, когда сервер ответил 304 на запрос с ETag.
var ErrNotModified = errors.New("not modified")

type Client struct {
	BaseURL string
	HTTP    *http.Client

	mu    sync.Mutex
	etags map[string]string
	next  time.Time
}

func New(baseURL string) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 60 * time.Second},
		etags:   map[string]string{},
	}
}

// Get скачивает путь API. Если ответ не менялся с прошлого раза, возвращает ErrNotModified.
func (c *Client) Get(ctx context.Context, path string) ([]byte, error) {
	return c.get(ctx, path, true)
}

// Fetch скачивает путь API без ETag: для справочных запросов, которые нужны каждый раз целиком.
func (c *Client) Fetch(ctx context.Context, path string) ([]byte, error) {
	return c.get(ctx, path, false)
}

// wait держит не больше 4 запросов в секунду (лимит API 300 в минуту).
func (c *Client) wait(ctx context.Context) error {
	c.mu.Lock()
	now := time.Now()
	if c.next.Before(now) {
		c.next = now
	}
	at := c.next
	c.next = c.next.Add(250 * time.Millisecond)
	c.mu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(time.Until(at)):
		return nil
	}
}

func (c *Client) get(ctx context.Context, path string, useETag bool) ([]byte, error) {
	if err := c.wait(ctx); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "ForeverGold-daemon (+https://github.com/fexolm/forevergold)")
	c.mu.Lock()
	if tag := c.etags[path]; useETag && tag != "" {
		req.Header.Set("If-None-Match", tag)
	}
	c.mu.Unlock()

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusNotModified:
		return nil, ErrNotModified
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable:
		return nil, fmt.Errorf("%s: %s, retry after %s", path, resp.Status, resp.Header.Get("Retry-After"))
	case resp.StatusCode != http.StatusOK:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return nil, fmt.Errorf("%s: %s: %s", path, resp.Status, strings.TrimSpace(string(body)))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if tag := resp.Header.Get("ETag"); useETag && tag != "" {
		c.mu.Lock()
		c.etags[path] = tag
		c.mu.Unlock()
	}
	return body, nil
}

// Row это одна строка таблицы цен. Цены в меди за штуку; 0 значит «неизвестно».
type Row struct {
	ItemID    int64
	Median    int64
	MinBuyout int64
	Quantity  int64
	Median7d  int64
	Median30d int64
	Low30d    int64
	High30d   int64
	// SalesX10: оценка продаж в день, умноженная на 10.
	SalesX10 int64
}

type PriceTable struct {
	Market string
	Time   time.Time
	Rows   []Row
	Raw    []byte
}

// ParsePriceTable разбирает текст /v1/pricetable: заголовок "AHL1|market|unix|count" и строки "id:median:min:...".
func ParsePriceTable(raw []byte) (*PriceTable, error) {
	pt := &PriceTable{Raw: raw}
	sc := bufio.NewScanner(strings.NewReader(string(raw)))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	first := true
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if first {
			first = false
			parts := strings.Split(line, "|")
			if len(parts) < 3 || parts[0] != "AHL1" {
				return nil, fmt.Errorf("unexpected pricetable header %q", truncate(line, 80))
			}
			pt.Market = parts[1]
			unix, err := strconv.ParseInt(parts[2], 10, 64)
			if err != nil {
				return nil, fmt.Errorf("bad pricetable time %q", parts[2])
			}
			pt.Time = time.Unix(unix, 0)
			continue
		}
		f := strings.Split(line, ":")
		id, err := strconv.ParseInt(f[0], 10, 64)
		if err != nil {
			continue
		}
		num := func(i int) int64 {
			if i >= len(f) || f[i] == "" {
				return 0
			}
			v, _ := strconv.ParseInt(f[i], 10, 64)
			return v
		}
		pt.Rows = append(pt.Rows, Row{
			ItemID: id, Median: num(1), MinBuyout: num(2), Quantity: num(3),
			Median7d: num(4), Median30d: num(5), Low30d: num(6), High30d: num(7), SalesX10: num(8),
		})
	}
	if first {
		return nil, errors.New("empty pricetable")
	}
	return pt, sc.Err()
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
