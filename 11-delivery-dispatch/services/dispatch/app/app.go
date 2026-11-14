// Package app wires the dispatch service: HTTP router, outbox relay, consumers
// and periodic loops. It is used by cmd/dispatch and by the end-to-end tests.
package app

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go/jetstream"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/httpx"
	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/inbox"
	"deliverydispatch/pkg/natsx"
	"deliverydispatch/pkg/outbox"
	"deliverydispatch/pkg/runner"
	"deliverydispatch/services/dispatch/internal/httpapi"
	"deliverydispatch/services/dispatch/internal/consumers"
	"deliverydispatch/services/dispatch/internal/service"
)

// ServiceName is the name used for logs and consumer names.
const ServiceName = "dispatch"

// Deps are the external resources the service runs on.
type Deps struct {
	Pool   *pgxpool.Pool
	JS     jetstream.JetStream
	Clock  clock.Clock
	IDs    idgen.Generator
	Logger *slog.Logger
}

// App is a wired dispatch service.
type App struct {
	cfg     Config
	deps    Deps
	Service *service.Service
	Router  http.Handler
	Relay   *outbox.Relay

	processors map[natsx.Stream]*inbox.Processor
}

// New wires the dispatch service from cfg and deps. deps.JS may be nil, in
// which case there is no relay and Run starts only the loops.
func New(cfg Config, deps Deps) *App {
	svc := service.New(deps.Pool, cfg.Service, deps.Clock, deps.IDs, deps.Logger)
	a := &App{cfg: cfg, deps: deps, Service: svc}
	a.processors = map[natsx.Stream]*inbox.Processor{
		natsx.StreamOrders:   a.processor(natsx.StreamOrders, consumers.OrdersHandlers(svc)),
		natsx.StreamCouriers: a.processor(natsx.StreamCouriers, consumers.CouriersHandlers(svc)),
	}
	if deps.JS != nil {
		a.Relay = outbox.NewRelay(deps.Pool, natsx.NewPublisher(deps.JS), deps.Logger)
	}
	a.Router = a.router()
	return a
}

func (a *App) router() http.Handler {
	logger := a.deps.Logger
	r := chi.NewRouter()
	r.Use(httpx.RequestID(a.deps.IDs), httpx.AccessLog(logger), httpx.Recover(logger))
	r.NotFound(httpx.NotFoundHandler(logger))
	r.MethodNotAllowed(httpx.MethodNotAllowedHandler(logger))
	r.Get("/healthz", httpx.Health)
	r.Group(func(r chi.Router) {
		r.Use(auth.Middleware(auth.NewVerifier([]byte(a.cfg.Common.JWTSecret), a.deps.Clock), logger))
		httpapi.New(a.Service, logger).Mount(r)
	})
	return r
}

// Processors returns the inbox processors of the service's consumers, keyed by
// stream.
func (a *App) Processors() map[natsx.Stream]*inbox.Processor {
	return a.processors
}

func (a *App) processor(s natsx.Stream, handlers map[string]inbox.Handler) *inbox.Processor {
	return inbox.NewProcessor(a.deps.Pool, natsx.DurableName(ServiceName, s), handlers, a.deps.Clock, a.deps.IDs, a.deps.Logger)
}

// Loops returns the service's periodic loops.
func (a *App) Loops() []runner.Loop {
	return []runner.Loop{
		{Name: "purge", Interval: time.Hour, RunOnce: a.purge},
	}
}

func (a *App) purge(ctx context.Context, now time.Time) error {
	if _, err := outbox.Purge(ctx, a.deps.Pool, now); err != nil {
		return err
	}
	_, err := inbox.Purge(ctx, a.deps.Pool, now)
	return err
}

// Run starts the consumers and, when loops are enabled, the outbox relay and
// the periodic loops, and blocks until ctx is done and they have stopped.
func (a *App) Run(ctx context.Context) {
	var wg sync.WaitGroup
	if a.cfg.Common.LoopsEnabled {
		runner.Start(ctx, &wg, a.deps.Clock, a.deps.IDs, a.deps.Logger, a.Loops()...)
		if a.Relay != nil {
			wg.Add(1)
			go func() {
				defer wg.Done()
				a.Relay.Run(ctx, a.deps.Clock, outbox.DefaultInterval)
			}()
		}
	}
	if a.deps.JS != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a.consume(ctx)
		}()
	}
	wg.Wait()
}

func (a *App) consume(ctx context.Context) {
	if !natsx.WaitForStreams(ctx, a.deps.JS, a.deps.Logger, natsx.StreamDispatch, natsx.StreamOrders, natsx.StreamCouriers) {
		return
	}
	var wg sync.WaitGroup
	for stream, p := range a.Processors() {
		wg.Add(1)
		go func(stream natsx.Stream, p *inbox.Processor) {
			defer wg.Done()
			natsx.Consume(ctx, a.deps.JS, stream, p, a.deps.Logger)
		}(stream, p)
	}
	wg.Wait()
}
