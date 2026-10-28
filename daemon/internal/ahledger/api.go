package ahledger

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ItemMeta это справочные данные предмета из /v1/tooltip (названия только английские).
type ItemMeta struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Quality   string `json:"quality"`
	Icon      string `json:"icon"`
	Level     int64  `json:"level"`
	ItemClass string `json:"itemClass"`
}

// Tooltip отдаёт справку по 100 предметам за раз.
func (c *Client) Tooltip(ctx context.Context, market string, ids []int64) ([]ItemMeta, error) {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.FormatInt(id, 10)
	}
	body, err := c.Fetch(ctx, "/v1/tooltip/"+market+"?items="+strings.Join(parts, ","))
	if err != nil {
		return nil, err
	}
	var resp struct {
		Items []ItemMeta `json:"items"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("tooltip: %w", err)
	}
	return resp.Items, nil
}

// ItemInfo это /v1/items/{id}: подкласс и цена у вендора, которых нет в tooltip.
type ItemInfo struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	Quality       string `json:"quality"`
	ItemClass     string `json:"itemClass"`
	ItemSubclass  string `json:"itemSubclass"`
	Level         int64  `json:"level"`
	RequiredLevel *int64 `json:"requiredLevel"`
	VendorSell    int64  `json:"vendorSell"`
	Icon          string `json:"icon"`
}

func (c *Client) Item(ctx context.Context, id int64) (*ItemInfo, error) {
	body, err := c.Fetch(ctx, fmt.Sprintf("/v1/items/%d?game=forever", id))
	if err != nil {
		return nil, err
	}
	var it ItemInfo
	if err := json.Unmarshal(body, &it); err != nil {
		return nil, fmt.Errorf("item %d: %w", id, err)
	}
	return &it, nil
}

// HistPoint это точка истории цены из /v1/prices.
type HistPoint struct {
	T        time.Time `json:"t"`
	Min      int64     `json:"min"`
	Median   int64     `json:"median"`
	P25      int64     `json:"p25"`
	P75      int64     `json:"p75"`
	Quantity int64     `json:"quantity"`
	Auctions int64     `json:"auctions"`
}

type Prices struct {
	Sales struct {
		EstimatedPerDay *float64 `json:"estimatedPerDay"`
	} `json:"sales"`
	Series []HistPoint `json:"series"`
}

// PriceHistory: range 24h (каждый полный скан), 7d (по часам), 30d и 90d (по дням).
func (c *Client) PriceHistory(ctx context.Context, market string, id int64, rng string) (*Prices, error) {
	body, err := c.Fetch(ctx, fmt.Sprintf("/v1/prices/%s/%d?range=%s", market, id, url.QueryEscape(rng)))
	if err != nil {
		return nil, err
	}
	var p Prices
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, fmt.Errorf("prices %d: %w", id, err)
	}
	return &p, nil
}

type MarketInfo struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Region string `json:"region"`
	Status string `json:"status"`
	Open   bool   `json:"open"`
}

// Markets: рынки Forever и есть ли на них цены (по /v1/economy).
func (c *Client) Markets(ctx context.Context) ([]MarketInfo, error) {
	body, err := c.Fetch(ctx, "/v1/markets")
	if err != nil {
		return nil, err
	}
	var list struct {
		Markets []struct {
			ID     string `json:"id"`
			Game   string `json:"game"`
			Region string `json:"region"`
			Label  string `json:"label"`
		} `json:"markets"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, fmt.Errorf("markets: %w", err)
	}
	status := map[string]string{}
	if body, err := c.Fetch(ctx, "/v1/economy"); err == nil {
		var eco struct {
			Markets []struct {
				Market       string `json:"market"`
				MarketStatus string `json:"marketStatus"`
			} `json:"markets"`
		}
		if json.Unmarshal(body, &eco) == nil {
			for _, m := range eco.Markets {
				status[m.Market] = m.MarketStatus
			}
		}
	}
	out := []MarketInfo{}
	for _, m := range list.Markets {
		if m.Game != "forever" {
			continue
		}
		st := status[m.ID]
		if st == "" {
			st = "not open yet"
		}
		out = append(out, MarketInfo{ID: m.ID, Label: m.Label, Region: m.Region, Status: st, Open: st != "not open yet"})
	}
	return out, nil
}
