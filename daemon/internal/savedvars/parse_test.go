package savedvars

import "testing"

func TestParse(t *testing.T) {
	src := `
ForeverGoldDB = {
	["reserveGold"] = 500,
	["export"] = {
		["version"] = 1,
		["names"] = {
			[2447] = "Мироцвет",
			[765] = "Сребролист \"тест\"",
		},
		["scans"] = {
			{
				["t"] = 1793000000,
				["items"] = {
					[2447] = "100,150;100:50;120:100",
				},
			}, -- [1]
		},
	},
	["items"] = {
		[2447] = { ["days"] = { [20750] = 123.5 } },
	},
	["flag"] = true,
	["list"] = { "a", "b", nil, },
}
OtherGlobal = nil
`
	vars, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	db := vars["ForeverGoldDB"]
	if got := Get(db, "export", "names", int64(2447)); got != "Мироцвет" {
		t.Fatalf("name = %v", got)
	}
	if got := Get(db, "export", "names", int64(765)); got != `Сребролист "тест"` {
		t.Fatalf("escaped name = %v", got)
	}
	scans := Array(Get(db, "export", "scans"))
	if len(scans) != 1 {
		t.Fatalf("scans = %d", len(scans))
	}
	if ts, _ := Int(Get(scans[0], "t")); ts != 1793000000 {
		t.Fatalf("t = %d", ts)
	}
	if got := Get(db, "items", int64(2447), "days", int64(20750)); got != 123.5 {
		t.Fatalf("float = %v", got)
	}
	if Get(db, "flag") != true {
		t.Fatal("bool")
	}
	if l := Array(Get(db, "list")); len(l) != 2 {
		t.Fatalf("list = %v", l)
	}
}
