// Package migrations embeds the goose SQL migrations and applies them.
package migrations

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"log/slog"

	"github.com/pressly/goose/v3"
)

//go:embed *.sql
var files embed.FS

// Run executes a goose command ("up", "down" or "status") against db.
func Run(ctx context.Context, db *sql.DB, command string, log *slog.Logger) error {
	goose.SetBaseFS(files)
	goose.SetLogger(gooseLogger{log: log})
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("setting goose dialect: %w", err)
	}

	var err error
	switch command {
	case "up":
		err = goose.UpContext(ctx, db, ".")
	case "down":
		err = goose.DownContext(ctx, db, ".")
	case "status":
		err = goose.StatusContext(ctx, db, ".")
	default:
		return fmt.Errorf("unknown migrate command %q (want up, down or status)", command)
	}
	if err != nil {
		return fmt.Errorf("migrate %s: %w", command, err)
	}
	return nil
}

type gooseLogger struct {
	log *slog.Logger
}

func (l gooseLogger) Printf(format string, v ...interface{}) {
	l.log.Info(fmt.Sprintf(format, v...), "component", "goose")
}

func (l gooseLogger) Fatalf(format string, v ...interface{}) {
	l.log.Error(fmt.Sprintf(format, v...), "component", "goose")
}
