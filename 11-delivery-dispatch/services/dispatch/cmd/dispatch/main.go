// Command dispatch runs the dispatch service.
//
//	dispatch serve        HTTP API, outbox relay, consumers and loops
//	dispatch migrate up|down|status
//	dispatch seed         idempotent demo data and seed tokens
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/logging"
	"deliverydispatch/pkg/migrate"
	"deliverydispatch/pkg/natsx"
	"deliverydispatch/services/dispatch/app"
	"deliverydispatch/services/dispatch/migrations"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "dispatch:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: dispatch serve | migrate up|down|status | seed")
	}
	cfg, err := app.LoadConfig(os.LookupEnv)
	if err != nil {
		return err
	}
	logger, err := logging.New(os.Stdout, cfg.Common.LogLevel, app.ServiceName)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch args[0] {
	case "serve":
		return serve(ctx, cfg, logger)
	case "migrate":
		command := "up"
		if len(args) > 1 {
			command = args[1]
		}
		return migrate.Run(ctx, cfg.DatabaseURL, migrations.FS, command)
	case "seed":
		return seed(ctx, cfg)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func serve(ctx context.Context, cfg app.Config, logger *slog.Logger) error {
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer pool.Close()
	nc, js, err := natsx.Connect(cfg.Common.NATSURL, app.ServiceName, logger)
	if err != nil {
		return err
	}
	defer nc.Close()

	a := app.New(cfg, app.Deps{Pool: pool, JS: js, Clock: clock.System{}, IDs: idgen.Random{}, Logger: logger})
	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           a.Router,
		ReadHeaderTimeout: 5 * time.Second,
	}
	runCtx, stopWorkers := context.WithCancel(ctx)
	defer stopWorkers()
	workers := make(chan struct{})
	go func() {
		defer close(workers)
		a.Run(runCtx)
	}()
	serveErr := make(chan error, 1)
	go func() {
		logger.Info("http listening", "addr", cfg.HTTPAddr)
		serveErr <- srv.ListenAndServe()
	}()

	var result error
	select {
	case <-ctx.Done():
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			result = fmt.Errorf("http server: %w", err)
		}
	}
	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Warn("http shutdown failed", "error", err.Error())
	}
	stopWorkers()
	<-workers
	return result
}

// seed prints tokens only: dispatch data is built from events.
func seed(_ context.Context, cfg app.Config) error {
	fmt.Println("dispatch has no seed data; couriers appear once they start a shift")
	return auth.PrintSeedTokens(os.Stdout, []byte(cfg.Common.JWTSecret), clock.System{}.Now(), map[string]auth.Principal{
		"ops":       auth.SeedOps,
		"courier-1": {Subject: auth.SeedCourierIDs[0], Role: auth.RoleCourier},
	})
}
