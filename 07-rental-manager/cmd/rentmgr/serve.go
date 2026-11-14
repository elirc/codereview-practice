package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/store"
	"rentalmanager/internal/web"
)

func runServe(ctx context.Context, a *app, args []string) error {
	if len(args) > 0 {
		return errors.New("serve takes no arguments")
	}
	pool, err := store.Open(ctx, a.cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	srv, err := web.New(web.Options{
		Config:     a.cfg,
		Logger:     a.log,
		Pool:       pool,
		Clock:      calendar.SystemClock{},
		BcryptCost: auth.BcryptCost,
	})
	if err != nil {
		return err
	}

	httpServer := &http.Server{
		Addr:              a.cfg.HTTPAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errc := make(chan error, 1)
	go func() { errc <- httpServer.ListenAndServe() }()
	a.log.Info("http server listening", "addr", a.cfg.HTTPAddr, "env", a.cfg.Env)

	select {
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("http server: %w", err)
	case <-ctx.Done():
	}

	a.log.Info("http server shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutting down http server: %w", err)
	}
	return nil
}
