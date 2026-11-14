package web

import (
	"net/http"
	"net/url"

	"github.com/jackc/pgx/v5/pgtype"

	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

type tenantInput struct {
	FullName string
	Email    string
	Phone    string
}

func parseTenant(f *form) tenantInput {
	return tenantInput{
		FullName: f.text("full_name", true, 120),
		Email:    f.email("email", false),
		Phone:    f.text("phone", false, 40),
	}
}

func (s *Server) listTenants(w http.ResponseWriter, r *http.Request) {
	s.renderTenants(w, r, http.StatusOK, s.newView(r, "Tenants", nil))
}

func (s *Server) renderTenants(w http.ResponseWriter, r *http.Request, status int, v *view) {
	tenants, err := s.q.ListTenants(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	v.Data = tenants
	s.render(w, r, status, "tenants.html", v)
}

func (s *Server) createTenant(w http.ResponseWriter, r *http.Request) {
	f, err := postForm(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	in := parseTenant(f)
	if f.err() != nil {
		v := s.newView(r, "Tenants", nil)
		v.Form, v.Errors = f.values, f.errs.Map()
		s.renderTenants(w, r, http.StatusUnprocessableEntity, v)
		return
	}
	t, err := s.q.CreateTenant(r.Context(), db.CreateTenantParams{
		FullName: in.FullName,
		Email:    store.Text(in.Email),
		Phone:    store.Text(in.Phone),
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.flash(r, "Tenant created.")
	http.Redirect(w, r, "/tenants/"+store.FormatUUID(t.ID), http.StatusSeeOther)
}

type tenantPage struct {
	Tenant db.Tenant
	Leases []db.ListTenantLeasesRow
}

func (s *Server) showTenant(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(r, "id")
	if !ok {
		s.fail(w, r, errNotFound)
		return
	}
	s.renderTenant(w, r, http.StatusOK, id, nil, nil)
}

func (s *Server) renderTenant(w http.ResponseWriter, r *http.Request, status int, id pgtype.UUID, values url.Values, errs map[string]string) {
	t, err := s.q.GetTenant(r.Context(), id)
	if store.IsNotFound(err) {
		s.fail(w, r, errNotFound)
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	leases, err := s.q.ListTenantLeases(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	v := s.newView(r, t.FullName, tenantPage{Tenant: t, Leases: leases})
	v.Form = url.Values{"full_name": {t.FullName}, "email": {t.Email.String}, "phone": {t.Phone.String}}
	if values != nil {
		v.Form, v.Errors = values, errs
	}
	s.render(w, r, status, "tenant.html", v)
}

func (s *Server) updateTenant(w http.ResponseWriter, r *http.Request) {
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
	in := parseTenant(f)
	if f.err() != nil {
		s.renderTenant(w, r, http.StatusUnprocessableEntity, id, f.values, f.errs.Map())
		return
	}
	_, err = s.q.UpdateTenant(r.Context(), db.UpdateTenantParams{
		ID:       id,
		FullName: in.FullName,
		Email:    store.Text(in.Email),
		Phone:    store.Text(in.Phone),
	})
	if store.IsNotFound(err) {
		s.fail(w, r, errNotFound)
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.flash(r, "Tenant saved.")
	http.Redirect(w, r, "/tenants/"+store.FormatUUID(id), http.StatusSeeOther)
}
