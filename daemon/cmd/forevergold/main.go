// forevergold.exe: фоновый демон ForeverGold. Синкает цены AHledger и сканы аддона,
// хранит историю в SQLite и показывает анализ рынка на http://localhost:8765.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"time"

	"github.com/fexolm/forevergold/daemon/internal/app"
	"github.com/fexolm/forevergold/daemon/internal/store"
	"github.com/fexolm/forevergold/daemon/internal/web"
)

func main() {
	exe, _ := os.Executable()
	baseDir := filepath.Dir(exe)

	dataDir := flag.String("data", baseDir, "папка для config.json, базы и лога")
	wow := flag.String("wow", "", "папка клиента Forever (с Interface и WTF); сохраняется в config.json")
	openBrowser := flag.Bool("open", false, "открыть веб-интерфейс в браузере")
	flag.Parse()

	if err := os.MkdirAll(*dataDir, 0o755); err != nil {
		log.Fatal(err)
	}
	logFile, err := os.OpenFile(filepath.Join(*dataDir, "forevergold.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err == nil {
		log.SetOutput(io.MultiWriter(os.Stderr, logFile))
	}

	cfgPath := filepath.Join(*dataDir, "config.json")
	cfg, err := loadConfig(cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if *wow != "" {
		cfg.WowPath = *wow
	}
	if cfg.WowPath == "" {
		cfg.WowPath = detectWow()
	}
	if err := saveConfig(cfgPath, cfg); err != nil {
		log.Printf("config: %v", err)
	}
	if cfg.WowPath == "" {
		log.Printf("папка игры не найдена: укажите wowPath в %s, пока работаю только с AHledger", cfgPath)
	}

	// Второй экземпляр не нужен: если порт занят, просто открываем интерфейс.
	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		log.Printf("порт %s занят, похоже, демон уже запущен", cfg.Listen)
		if *openBrowser {
			openURL("http://" + cfg.Listen)
		}
		return
	}

	st, err := store.Open(filepath.Join(*dataDir, "forevergold.db"))
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer st.Close()

	a := app.New(cfg, st)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go a.Run(ctx)

	srv := &http.Server{Handler: (&web.Server{App: a}).Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	url := "http://" + cfg.Listen
	log.Printf("ForeverGold: %s, рынок %s, игра %q", url, cfg.Market, cfg.WowPath)
	if *openBrowser {
		openURL(url)
	}
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func loadConfig(path string) (app.Config, error) {
	cfg := app.DefaultConfig()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("%s: %w", path, err)
	}
	return cfg, nil
}

func saveConfig(path string, cfg app.Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

// detectWow ищет клиент Forever в стандартных местах установки.
func detectWow() string {
	if runtime.GOOS != "windows" {
		return ""
	}
	var roots []string
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles"} {
		if p := os.Getenv(env); p != "" {
			roots = append(roots, filepath.Join(p, "World of Warcraft"))
		}
	}
	roots = append(roots, `C:\World of Warcraft`, `D:\World of Warcraft`, `D:\Games\World of Warcraft`)
	for _, root := range roots {
		for _, flavor := range []string{"_forever_", "_forever", "_classic_beta_"} {
			dir := filepath.Join(root, flavor)
			if info, err := os.Stat(filepath.Join(dir, "Interface")); err == nil && info.IsDir() {
				return dir
			}
		}
	}
	return ""
}

func openURL(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("не удалось открыть браузер: %v", err)
	}
}
