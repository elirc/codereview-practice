package web

import (
	"errors"
	"net/http"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/ledger"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

func (s *Server) loginForm(w http.ResponseWriter, r *http.Request) {
	if currentUser(r) != nil {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	s.render(w, r, http.StatusOK, "login.html", s.newView(r, "Sign in", nil))
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	f, err := postForm(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	email := f.text("email", true, 254)
	password := f.raw("password")
	if password == "" {
		f.fail("password", "is required")
	} else if len(password) > auth.MaxPasswordLength {
		f.fail("password", "is too long")
	}

	v := s.newView(r, "Sign in", nil)
	v.Form.Set("email", email)
	if err := f.err(); err != nil {
		v.Errors = f.errs.Map()
		s.render(w, r, http.StatusUnprocessableEntity, "login.html", v)
		return
	}

	u, err := s.users.Authenticate(r.Context(), email, password)
	if errors.Is(err, auth.ErrInvalidCredentials) {
		s.logger(r).Info("login failed")
		v.Errors["email"] = "Invalid email or password."
		s.render(w, r, http.StatusUnauthorized, "login.html", v)
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}

	if err := s.sessions.RenewToken(r.Context()); err != nil {
		s.fail(w, r, err)
		return
	}
	s.sessions.Put(r.Context(), sessionUserKey, store.FormatUUID(u.ID))
	s.logger(r).Info("login succeeded", "user_id", store.FormatUUID(u.ID))
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if err := s.sessions.Destroy(r.Context()); err != nil {
		s.fail(w, r, err)
		return
	}
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

type dashboardData struct {
	Overview ledger.Overview
	Runs     []db.JobRun
}

func (s *Server) dashboard(w http.ResponseWriter, r *http.Request) {
	overview, err := s.ledger.Overview(r.Context(), s.today())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	data := dashboardData{Overview: overview}
	if currentUser(r).Role.Can(auth.PermRunJobs) {
		data.Runs, err = s.jobs.Recent(r.Context(), 5)
		if err != nil {
			s.fail(w, r, err)
			return
		}
	}
	s.render(w, r, http.StatusOK, "dashboard.html", s.newView(r, "Dashboard", data))
}
