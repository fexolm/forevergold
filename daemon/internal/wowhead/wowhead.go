// Package wowhead берёт русские названия предметов из тултипов Wowhead.
// AHledger отдаёт только английские названия. Названия из клиента игры (аддон) главнее:
// они точно совпадают с тем, что видно в игре.
package wowhead

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
	"unicode"
)

// dataEnv=16: база WoW: Forever на Wowhead (и старые предметы Classic, и новые предметы Forever).
const tooltipURL = "https://nether.wowhead.com/tooltip/item/%d?dataEnv=16&locale=7"

type Client struct {
	HTTP *http.Client
	// URL можно подменить в тестах; %d заменяется номером предмета.
	URL string
}

func New() *Client {
	return &Client{HTTP: &http.Client{Timeout: 20 * time.Second}, URL: tooltipURL}
}

// RuName возвращает русское название или "", если Wowhead его не знает.
func (c *Client) RuName(ctx context.Context, id int64) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf(c.URL, id), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "ForeverGold-daemon (+https://github.com/fexolm/forevergold)")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode == http.StatusNotFound {
		return "", nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("wowhead %d: %s", id, resp.Status)
	}
	var t struct {
		Name  string `json:"name"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &t); err != nil {
		return "", fmt.Errorf("wowhead %d: %w", id, err)
	}
	if t.Error != "" || !hasCyrillic(t.Name) {
		return "", nil
	}
	return t.Name, nil
}

func hasCyrillic(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Cyrillic, r) {
			return true
		}
	}
	return false
}
