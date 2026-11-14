package web

import (
	"bytes"
	"embed"
	"fmt"
	"html/template"
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/justinas/nosurf"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
)

//go:embed templates
var templateFiles embed.FS

// templates holds one parsed set per page: the layout, every partial and
// the page itself, so that pages can each define "content".
type templates struct {
	pages map[string]*template.Template
}

func parseTemplates(funcs template.FuncMap) (*templates, error) {
	pages, err := fs.Glob(templateFiles, "templates/pages/*.html")
	if err != nil {
		return nil, err
	}
	t := &templates{pages: make(map[string]*template.Template, len(pages))}
	for _, page := range pages {
		name := path.Base(page)
		tmpl, err := template.New(name).Funcs(funcs).ParseFS(templateFiles,
			"templates/layout.html", "templates/partials/*.html", page)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		t.pages[name] = tmpl
	}
	return t, nil
}

// view is the data every template receives.
type view struct {
	Title     string
	User      *auth.User
	CSRFToken string
	Flash     string
	Today     calendar.Date
	Form      url.Values
	Errors    map[string]string
	Data      any
}

func (s *Server) newView(r *http.Request, title string, data any) *view {
	return &view{
		Title:     title,
		User:      currentUser(r),
		CSRFToken: nosurf.Token(r),
		Today:     s.today(),
		Form:      url.Values{},
		Errors:    map[string]string{},
		Data:      data,
	}
}

// render writes a full page.
func (s *Server) render(w http.ResponseWriter, r *http.Request, status int, page string, v *view) {
	if v.Flash == "" && hasSession(r) {
		v.Flash = s.sessions.PopString(r.Context(), flashKey)
	}
	s.execute(w, r, status, page, "layout", v)
}

// renderFragment writes one named template of a page, for htmx swaps.
func (s *Server) renderFragment(w http.ResponseWriter, r *http.Request, status int, page, name string, v *view) {
	s.execute(w, r, status, page, name, v)
}

func (s *Server) execute(w http.ResponseWriter, r *http.Request, status int, page, name string, v *view) {
	t, ok := s.tmpl.pages[page]
	if !ok {
		s.logger(r).Error("unknown template", "template", page)
		http.Error(w, messageInternal, http.StatusInternalServerError)
		return
	}
	var buf bytes.Buffer
	if err := t.ExecuteTemplate(&buf, name, v); err != nil {
		s.logger(r).Error("rendering template", "template", page, "name", name, "error", err)
		http.Error(w, messageInternal, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if _, err := buf.WriteTo(w); err != nil {
		s.logger(r).Debug("writing response", "error", err)
	}
}

func (s *Server) funcs() template.FuncMap {
	return template.FuncMap{
		"cents": func(v any) string { return toCents(v).String() },
		"plain": func(v any) string { return toCents(v).Plain() },
		"date":  formatDate,
		"ts":    s.formatTime,
		"uuid":  store.FormatUUID,
		"kind":  func(k any) string { return billing.Kind(fmt.Sprint(k)).Label() },
		"can":   can,
	}
}

func toCents(v any) money.Cents {
	switch x := v.(type) {
	case money.Cents:
		return x
	case int64:
		return money.Cents(x)
	case *money.Cents:
		if x != nil {
			return *x
		}
	case pgtype.Int8:
		return money.Cents(x.Int64)
	}
	return 0
}

func formatDate(v any) string {
	switch x := v.(type) {
	case calendar.Date:
		if !x.IsZero() {
			return x.String()
		}
	case *calendar.Date:
		if x != nil {
			return x.String()
		}
	case pgtype.Date:
		if x.Valid {
			return store.ToDate(x).String()
		}
	}
	return ""
}

func (s *Server) formatTime(v any) string {
	var t time.Time
	switch x := v.(type) {
	case time.Time:
		t = x
	case pgtype.Timestamptz:
		if !x.Valid {
			return ""
		}
		t = x.Time
	default:
		return ""
	}
	return t.In(s.cfg.Location).Format("2006-01-02 15:04")
}

func can(u *auth.User, action string) bool {
	if u == nil {
		return false
	}
	perms := map[string]auth.Permission{
		"edit":    auth.PermEdit,
		"reverse": auth.PermReverse,
		"jobs":    auth.PermRunJobs,
		"users":   auth.PermManageUsers,
	}
	p, ok := perms[action]
	return ok && u.Role.Can(p)
}
