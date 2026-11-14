package web

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/jobs"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

type jobRunView struct {
	db.JobRun
	LeaseErrors []jobs.LeaseError
}

type jobsPage struct {
	Names []string
	Runs  []jobRunView
}

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	s.renderJobs(w, r, http.StatusOK, s.newView(r, "Jobs", nil))
}

func (s *Server) renderJobs(w http.ResponseWriter, r *http.Request, status int, v *view) {
	runs, err := s.jobs.Recent(r.Context(), 50)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	page := jobsPage{Names: jobs.Names}
	for _, run := range runs {
		errs, err := jobs.DecodeErrors(run.Errors)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		page.Runs = append(page.Runs, jobRunView{JobRun: run, LeaseErrors: errs})
	}
	v.Data = page
	if v.Form.Get("as_of") == "" {
		v.Form.Set("as_of", s.today().String())
	}
	s.render(w, r, status, "admin_jobs.html", v)
}

func (s *Server) runJob(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if _, ok := jobs.LockKey(name); !ok {
		s.fail(w, r, jobs.ErrUnknownJob)
		return
	}
	f, err := postForm(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	asOf := s.asOf(f)
	if f.err() == nil {
		// A run started from the browser finishes even if the client leaves.
		res, err := s.jobs.Run(context.WithoutCancel(r.Context()), name, asOf)
		if err == nil {
			if res.Skipped {
				s.flash(r, name+" was skipped because another run is in progress.")
			} else {
				s.flash(r, fmt.Sprintf("%s as of %s finished: %s, %d entries posted, %d lease errors.",
					name, asOf, res.Status, res.EntriesPosted, len(res.Errors)))
			}
			http.Redirect(w, r, "/admin/jobs", http.StatusSeeOther)
			return
		}
		if !ruleAsFormError(f, err) {
			s.fail(w, r, err)
			return
		}
	}
	v := s.newView(r, "Jobs", nil)
	v.Form, v.Errors = f.values, f.errs.Map()
	s.renderJobs(w, r, http.StatusUnprocessableEntity, v)
}

type usersPage struct {
	Users  []auth.User
	Roles  []auth.Role
	Failed string
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	s.renderUsers(w, r, http.StatusOK, "", nil)
}

func (s *Server) renderUsers(w http.ResponseWriter, r *http.Request, status int, failed string, f *form) {
	users, err := s.users.List(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	v := s.newView(r, "Users", usersPage{Users: users, Roles: auth.Roles, Failed: failed})
	v.Form.Set("role", string(auth.RoleViewer))
	if f != nil {
		v.Form, v.Errors = f.values, f.errs.Map()
	}
	s.render(w, r, status, "admin_users.html", v)
}

func parseRole(f *form) auth.Role {
	role, _ := auth.ParseRole(f.choice("role", string(auth.RoleViewer), string(auth.RoleManager), string(auth.RoleAdmin)))
	return role
}

func parsePassword(f *form, required bool) string {
	pw := f.raw("password")
	switch {
	case pw == "" && required:
		f.fail("password", "is required")
	case pw != "" && len(pw) < auth.MinPasswordLength:
		f.fail("password", fmt.Sprintf("must be at least %d characters", auth.MinPasswordLength))
	case len(pw) > auth.MaxPasswordLength:
		f.fail("password", fmt.Sprintf("must be at most %d bytes", auth.MaxPasswordLength))
	}
	return pw
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	f, err := postForm(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	in := auth.NewUser{
		Email:    auth.NormalizeEmail(f.email("email", true)),
		Name:     f.text("name", true, 120),
		Role:     parseRole(f),
		Password: parsePassword(f, true),
	}
	if f.err() == nil {
		_, err := s.users.Create(r.Context(), s.actor(r), in)
		switch {
		case err == nil:
			s.flash(r, "User "+in.Email+" created.")
			http.Redirect(w, r, "/admin/users", http.StatusSeeOther)
			return
		case errors.Is(err, auth.ErrEmailTaken):
			f.fail("email", "is already used by another user")
		default:
			s.fail(w, r, err)
			return
		}
	}
	s.renderUsers(w, r, http.StatusUnprocessableEntity, "new", f)
}

func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(r, "id")
	if !ok {
		s.fail(w, r, errNotFound)
		return
	}
	f, err := postForm(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	in := auth.UserUpdate{
		Name:     f.text("name", true, 120),
		Role:     parseRole(f),
		Active:   f.checked("active"),
		Password: parsePassword(f, false),
	}
	if f.err() == nil {
		_, err := s.users.Update(r.Context(), s.actor(r), id, in)
		if err == nil {
			s.flash(r, "User saved.")
			http.Redirect(w, r, "/admin/users", http.StatusSeeOther)
			return
		}
		if !ruleAsFormError(f, err) {
			s.fail(w, r, err)
			return
		}
	}
	s.renderUsers(w, r, http.StatusUnprocessableEntity, store.FormatUUID(id), f)
}
