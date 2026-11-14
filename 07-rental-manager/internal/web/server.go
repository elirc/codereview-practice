// Package web serves the back-office UI and the small JSON API.
package web

import (
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	"github.com/alexedwards/scs/pgxstore"
	"github.com/alexedwards/scs/v2"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/config"
	"rentalmanager/internal/jobs"
	"rentalmanager/internal/lease"
	"rentalmanager/internal/ledger"
	"rentalmanager/internal/store/db"
)

//go:embed static
var staticFiles embed.FS

// Options are the dependencies of a Server.
type Options struct {
	Config     config.Config
	Logger     *slog.Logger
	Pool       *pgxpool.Pool
	Clock      calendar.Clock
	BcryptCost int
}

// Server holds the HTTP handlers and their dependencies.
type Server struct {
	cfg      config.Config
	log      *slog.Logger
	clock    calendar.Clock
	q        *db.Queries
	sessions *scs.SessionManager
	tmpl     *templates
	users    *auth.Service
	leases   *lease.Service
	ledger   *ledger.Service
	jobs     *jobs.Runner
}

// New builds a Server, parsing every template up front.
func New(o Options) (*Server, error) {
	users, err := auth.NewService(o.Pool, o.BcryptCost)
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg:    o.Config,
		log:    o.Logger,
		clock:  o.Clock,
		q:      db.New(o.Pool),
		users:  users,
		leases: lease.NewService(o.Pool, o.Clock, o.Config.Location),
		ledger: ledger.NewService(o.Pool, o.Clock, o.Config.Location),
		jobs:   jobs.NewRunner(o.Pool, o.Clock, o.Config.Location, o.Logger),
	}
	s.tmpl, err = parseTemplates(s.funcs())
	if err != nil {
		return nil, fmt.Errorf("parsing templates: %w", err)
	}

	sm := scs.New()
	sm.Store = pgxstore.New(o.Pool)
	sm.Lifetime = 12 * time.Hour
	sm.IdleTimeout = 2 * time.Hour
	sm.Cookie.Name = "rentmgr_session"
	sm.Cookie.HttpOnly = true
	sm.Cookie.SameSite = http.SameSiteLaxMode
	sm.Cookie.Secure = o.Config.Production()
	sm.ErrorFunc = func(w http.ResponseWriter, r *http.Request, err error) {
		s.fail(w, r, fmt.Errorf("session store: %w", err))
	}
	s.sessions = sm
	return s, nil
}

// Handler returns the root HTTP handler.
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(s.requestID, s.logRequests, s.recoverPanics, limitBody)
	r.NotFound(func(w http.ResponseWriter, r *http.Request) { s.fail(w, r, errNotFound) })

	r.Get("/healthz", s.healthz)
	r.Handle("/static/*", s.staticHandler())

	r.Group(func(r chi.Router) {
		r.Use(s.sessions.LoadAndSave, s.csrf, s.loadUser)
		r.Get("/login", s.loginForm)
		r.Post("/login", s.login)

		r.Group(func(r chi.Router) {
			r.Use(s.requireUser)
			r.Post("/logout", s.logout)
			r.Get("/", s.dashboard)
		})
	})
	return r
}

func (s *Server) staticHandler() http.Handler {
	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		// The embedded directory name is fixed at compile time.
		panic(err)
	}
	return http.StripPrefix("/static/", http.FileServer(http.FS(sub)))
}

func (s *Server) today() calendar.Date {
	return calendar.Today(s.clock, s.cfg.Location)
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if _, err := w.Write([]byte("ok\n")); err != nil {
		s.logger(r).Debug("writing health response", "error", err)
	}
}
