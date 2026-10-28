// Package savedvars разбирает файлы SavedVariables, которые пишет WoW: присваивания глобалам Lua-таблиц.
package savedvars

import (
	"fmt"
	"strconv"
	"strings"
)

// Table это Lua-таблица. Ключи: int64 для чисел, string для строк, bool для логических.
type Table map[any]any

// Parse возвращает значения глобальных переменных файла.
func Parse(src string) (map[string]any, error) {
	p := &parser{src: src}
	out := map[string]any{}
	for {
		p.skip()
		if p.eof() {
			return out, nil
		}
		name := p.ident()
		if name == "" {
			return nil, p.errorf("expected variable name")
		}
		p.skip()
		if !p.consume('=') {
			return nil, p.errorf("expected '=' after %s", name)
		}
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		out[name] = v
	}
}

type parser struct {
	src string
	pos int
}

func (p *parser) eof() bool { return p.pos >= len(p.src) }

func (p *parser) errorf(format string, args ...any) error {
	line := strings.Count(p.src[:min(p.pos, len(p.src))], "\n") + 1
	return fmt.Errorf("savedvars line %d: %s", line, fmt.Sprintf(format, args...))
}

// skip пропускает пробелы, ";" и комментарии.
func (p *parser) skip() {
	for !p.eof() {
		c := p.src[p.pos]
		switch {
		case c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == ';':
			p.pos++
		case strings.HasPrefix(p.src[p.pos:], "--[["):
			end := strings.Index(p.src[p.pos+4:], "]]")
			if end < 0 {
				p.pos = len(p.src)
			} else {
				p.pos += 4 + end + 2
			}
		case strings.HasPrefix(p.src[p.pos:], "--"):
			end := strings.IndexByte(p.src[p.pos:], '\n')
			if end < 0 {
				p.pos = len(p.src)
			} else {
				p.pos += end
			}
		default:
			return
		}
	}
}

func (p *parser) consume(c byte) bool {
	if !p.eof() && p.src[p.pos] == c {
		p.pos++
		return true
	}
	return false
}

func isIdent(c byte, first bool) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (!first && c >= '0' && c <= '9')
}

func (p *parser) ident() string {
	start := p.pos
	for !p.eof() && isIdent(p.src[p.pos], p.pos == start) {
		p.pos++
	}
	return p.src[start:p.pos]
}

func (p *parser) value() (any, error) {
	p.skip()
	if p.eof() {
		return nil, p.errorf("unexpected end of file")
	}
	c := p.src[p.pos]
	switch {
	case c == '{':
		return p.table()
	case c == '"' || c == '\'':
		return p.str()
	case c == '-' || c == '.' || (c >= '0' && c <= '9'):
		return p.number()
	}
	switch word := p.ident(); word {
	case "true":
		return true, nil
	case "false":
		return false, nil
	case "nil":
		return nil, nil
	default:
		return nil, p.errorf("unexpected %q", word)
	}
}

func (p *parser) number() (any, error) {
	start := p.pos
	for !p.eof() && strings.IndexByte("0123456789+-.eExXabcdefABCDEF", p.src[p.pos]) >= 0 {
		p.pos++
	}
	text := p.src[start:p.pos]
	if i, err := strconv.ParseInt(text, 0, 64); err == nil {
		return i, nil
	}
	f, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return nil, p.errorf("bad number %q", text)
	}
	return f, nil
}

func (p *parser) str() (string, error) {
	quote := p.src[p.pos]
	p.pos++
	var b strings.Builder
	for {
		if p.eof() {
			return "", p.errorf("unterminated string")
		}
		c := p.src[p.pos]
		p.pos++
		switch {
		case c == quote:
			return b.String(), nil
		case c != '\\':
			b.WriteByte(c)
		default:
			if p.eof() {
				return "", p.errorf("unterminated escape")
			}
			e := p.src[p.pos]
			p.pos++
			switch e {
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			case 'r':
				b.WriteByte('\r')
			case '\n':
				b.WriteByte('\n')
			case '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
				// \ddd: до трёх десятичных цифр.
				n := int(e - '0')
				for i := 0; i < 2 && !p.eof() && p.src[p.pos] >= '0' && p.src[p.pos] <= '9'; i++ {
					n = n*10 + int(p.src[p.pos]-'0')
					p.pos++
				}
				b.WriteByte(byte(n))
			default:
				b.WriteByte(e)
			}
		}
	}
}

func (p *parser) table() (Table, error) {
	p.pos++ // {
	t := Table{}
	var next int64 = 1
	for {
		p.skip()
		if p.consume('}') {
			return t, nil
		}
		var key any
		if p.consume('[') {
			k, err := p.value()
			if err != nil {
				return nil, err
			}
			p.skip()
			if !p.consume(']') {
				return nil, p.errorf("expected ']'")
			}
			p.skip()
			if !p.consume('=') {
				return nil, p.errorf("expected '='")
			}
			key = normKey(k)
		} else if save := p.pos; isIdent(p.src[p.pos], true) {
			name := p.ident()
			p.skip()
			if p.consume('=') {
				key = name
			} else {
				p.pos = save // это значение (true/false/nil), а не ключ
			}
		}
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		if key == nil {
			key = next
			next++
		}
		if v != nil {
			t[key] = v
		}
		p.skip()
		if !p.consume(',') && !p.consume(';') {
			p.skip()
			if !p.consume('}') {
				return nil, p.errorf("expected ',' or '}'")
			}
			return t, nil
		}
	}
}

// normKey приводит целые числа с плавающей точкой (1.0) к int64, как это делает Lua для ключей.
func normKey(k any) any {
	if f, ok := k.(float64); ok && f == float64(int64(f)) {
		return int64(f)
	}
	return k
}

// Get идёт по пути ключей; возвращает nil, если чего-то нет.
func Get(v any, path ...any) any {
	for _, k := range path {
		t, ok := v.(Table)
		if !ok {
			return nil
		}
		v = t[k]
	}
	return v
}

// Array возвращает элементы t[1], t[2], ... до первого пропуска.
func Array(v any) []any {
	t, ok := v.(Table)
	if !ok {
		return nil
	}
	var out []any
	for i := int64(1); ; i++ {
		x, ok := t[i]
		if !ok {
			return out
		}
		out = append(out, x)
	}
}

func Int(v any) (int64, bool) {
	switch x := v.(type) {
	case int64:
		return x, true
	case float64:
		return int64(x), true
	}
	return 0, false
}
