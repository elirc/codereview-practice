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

			r.Get("/properties", s.listProperties)
			r.Get("/properties/{id}", s.showProperty)
			r.Get("/tenants", s.listTenants)
			r.Get("/tenants/{id}", s.showTenant)
			r.Get("/leases", s.listLeases)
			r.Get("/leases/{id}", s.showLease)
			r.Get("/leases/{id}/ledger", s.showLedger)
			r.Post("/entries/{id}/memo", s.updateEntryMemo)
			r.Get("/reports/rent-roll", s.rentRoll)
			r.Get("/reports/aging", s.aging)
			r.Get("/api/leases/{id}/statement", s.apiStatement)

			r.Group(func(r chi.Router) {
				r.Use(s.require(auth.PermEdit))
				r.Post("/properties", s.createProperty)
				r.Post("/properties/{id}", s.updateProperty)
				r.Post("/properties/{id}/units", s.createUnit)
				r.Post("/units/{id}", s.updateUnit)
				r.Post("/tenants", s.createTenant)
				r.Post("/tenants/{id}", s.updateTenant)
				r.Get("/leases/new", s.newLease)
				r.Post("/leases", s.createLease)
				r.Post("/leases/{id}", s.updateLease)
				r.Post("/leases/{id}/activate", s.activateLease)
				r.Get("/leases/{id}/end", s.endLeaseForm)
				r.Post("/leases/{id}/end", s.endLease)
				r.Post("/leases/{id}/delete", s.deleteLease)
				r.Post("/leases/{id}/entries", s.createEntry)
			})

			r.Group(func(r chi.Router) {
				r.Use(s.require(auth.PermReverse))
				r.Post("/entries/{id}/reverse", s.reverseEntry)
			})

			r.Group(func(r chi.Router) {
				r.Use(s.require(auth.PermRunJobs))
				r.Get("/admin/jobs", s.listJobs)
				r.Post("/admin/jobs/{name}/run", s.runJob)
			})

			r.Group(func(r chi.Router) {
				r.Use(s.require(auth.PermManageUsers))
				r.Get("/admin/users", s.listUsers)
				r.Post("/admin/users", s.createUser)
				r.Post("/admin/users/{id}", s.updateUser)
			})
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
