// Command rentmgr runs the rental manager web server, the background worker
// and the maintenance tasks around them.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"sort"
	"syscall"
	_ "time/tzdata"

	"rentalmanager/internal/config"
)

type app struct {
	cfg config.Config
	log *slog.Logger
	out io.Writer
}

type command struct {
	summary string
	run     func(ctx context.Context, a *app, args []string) error
}

func commands() map[string]command {
	return map[string]command{
		"migrate": {summary: "apply database migrations: migrate [up|down|status]", run: runMigrate},
		"run-job": {summary: "run one job now: run-job <post-rent|assess-late-fees> [--as-of YYYY-MM-DD]", run: runJob},
		"serve":   {summary: "run the web server", run: runServe},
		"worker":  {summary: "run the background job worker (every 15 minutes)", run: runWorker},
	}
}

var errUsage = errors.New("usage: rentmgr <command> [arguments]")

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, os.Args[1:], os.Getenv, os.Stdout)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "rentmgr:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, getenv func(string) string, out io.Writer) error {
	cmds := commands()
	if len(args) == 0 {
		printUsage(out, cmds)
		return errUsage
	}
	cmd, ok := cmds[args[0]]
	if !ok {
		printUsage(out, cmds)
		return fmt.Errorf("unknown command %q", args[0])
	}

	cfg, err := config.Load(getenv)
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(out, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(logger)

	return cmd.run(ctx, &app{cfg: cfg, log: logger, out: out}, args[1:])
}

func printUsage(w io.Writer, cmds map[string]command) {
	names := make([]string, 0, len(cmds))
	for name := range cmds {
		names = append(names, name)
	}
	sort.Strings(names)
	fmt.Fprintln(w, errUsage.Error())
	fmt.Fprintln(w, "\ncommands:")
	for _, name := range names {
		fmt.Fprintf(w, "  %-18s %s\n", name, cmds[name].summary)
	}
}
