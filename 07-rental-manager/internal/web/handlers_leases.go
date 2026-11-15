package web

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/jackc/pgx/v5/pgtype"

	"rentalmanager/internal/apperr"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/lease"
	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

func parseFees(f *form) lease.FeeSettings {
	fees := lease.FeeSettings{
		GraceDays: f.integer("grace_days", 0, 15),
		Kind:      billing.FeeKind(f.choice("late_fee_kind", string(billing.FeeNone), string(billing.FeeFlat), string(billing.FeePercent))),
	}
	switch fees.Kind {
	case billing.FeeFlat:
		if c := f.amount("late_fee_flat", true, true); c != nil {
			fees.Flat = *c
		}
	case billing.FeePercent:
		fees.BPS = f.integer("late_fee_bps", 1, 2500)
	}
	if fees.Kind == billing.FeeFlat || fees.Kind == billing.FeePercent {
		fees.Cap = f.amount("late_fee_cap", false, true)
	}
	return fees
}

func parseTenants(f *form) lease.Tenants {
	ids := f.uuids("tenant_ids")
	primary := f.uuid("primary_tenant_id", false)
	if primary.Valid {
		found := false
		for _, id := range ids {
			found = found || id == primary
		}
		if !found {
			ids = append(ids, primary)
		}
	} else if len(ids) > 0 {
		f.fail("primary_tenant_id", "is required when tenants are selected")
	}
	return lease.Tenants{IDs: ids, Primary: primary}
}

func parseTerms(f *form) lease.Terms {
	t := lease.Terms{
		UnitID: f.uuid("unit_id", true),
		DueDay: f.integer("due_day", 1, 31),
		Fees:   parseFees(f),
	}
	if d := f.date("start_date", true); d != nil {
		t.Start = *d
	}
	t.End = f.date("end_date", false)
	if t.End != nil && !t.Start.IsZero() && t.End.Before(t.Start) {
		f.fail("end_date", "must be on or after the start date")
	}
	if c := f.amount("rent", true, true); c != nil {
		t.Rent = *c
	}
	if c := f.amount("deposit", false, false); c != nil {
		t.Deposit = *c
	}
	return t
}

// leaseValues fills the lease form from a stored lease.
func leaseValues(l db.Lease, tenants []db.ListLeaseTenantsRow) url.Values {
	v := url.Values{
		"unit_id":       {store.FormatUUID(l.UnitID)},
		"start_date":    {formatDate(l.StartDate)},
		"end_date":      {formatDate(l.EndDate)},
		"rent":          {money.Cents(l.RentCents).Plain()},
		"due_day":       {strconv.Itoa(int(l.DueDay))},
		"grace_days":    {strconv.Itoa(int(l.GraceDays))},
		"late_fee_kind": {l.LateFeeKind},
		"late_fee_bps":  {strconv.Itoa(int(l.LateFeeBps))},
		"deposit":       {money.Cents(l.DepositCents).Plain()},
	}
	if l.LateFeeFlatCents > 0 {
		v.Set("late_fee_flat", money.Cents(l.LateFeeFlatCents).Plain())
	}
	if l.LateFeeCapCents.Valid {
		v.Set("late_fee_cap", money.Cents(l.LateFeeCapCents.Int64).Plain())
	}
	for _, t := range tenants {
		v.Add("tenant_ids", store.FormatUUID(t.TenantID))
		if t.IsPrimary {
			v.Set("primary_tenant_id", store.FormatUUID(t.TenantID))
		}
	}
	return v
}

type leaseFormOptions struct {
	Units   []db.ListUnitOptionsRow
	Tenants []db.Tenant
}

func (s *Server) leaseFormOptions(r *http.Request) (leaseFormOptions, error) {
	units, err := s.q.ListUnitOptions(r.Context())
	if err != nil {
		return leaseFormOptions{}, fmt.Errorf("listing units: %w", err)
	}
	tenants, err := s.q.ListTenants(r.Context())
	if err != nil {
		return leaseFormOptions{}, fmt.Errorf("listing tenants: %w", err)
	}
	return leaseFormOptions{Units: units, Tenants: tenants}, nil
}

func (s *Server) listLeases(w http.ResponseWriter, r *http.Request) {
	rows, err := s.q.ListLeases(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.render(w, r, http.StatusOK, "leases.html", s.newView(r, "Leases", rows))
}

func (s *Server) newLease(w http.ResponseWriter, r *http.Request) {
	v := s.newView(r, "New lease", nil)
	v.Form = url.Values{"due_day": {"1"}, "grace_days": {"5"}, "late_fee_kind": {"none"}, "deposit": {"0.00"}}
	s.renderNewLease(w, r, http.StatusOK, v)
}

func (s *Server) renderNewLease(w http.ResponseWriter, r *http.Request, status int, v *view) {
	opts, err := s.leaseFormOptions(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	v.Data = leasePage{Options: opts}
	s.render(w, r, status, "lease_new.html", v)
}

func (s *Server) createLease(w http.ResponseWriter, r *http.Request) {
	f, err := postForm(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	terms := parseTerms(f)
	tenants := parseTenants(f)
	if f.err() == nil {
		l, err := s.leases.Create(r.Context(), s.actor(r), terms, tenants)
		if err == nil {
			s.flash(r, "Draft lease created.")
			http.Redirect(w, r, "/leases/"+store.FormatUUID(l.ID), http.StatusSeeOther)
			return
		}
		if !ruleAsFormError(f, err) {
			s.fail(w, r, err)
			return
		}
	}
	v := s.newView(r, "New lease", nil)
	v.Form, v.Errors = f.values, f.errs.Map()
	s.renderNewLease(w, r, http.StatusUnprocessableEntity, v)
}

// ruleAsFormError records a business-rule error as a form-level message so
// that the form can be shown again. It reports whether err was one.
func ruleAsFormError(f *form, err error) bool {
	var ae *apperr.Error
	if errors.As(err, &ae) && ae.Kind == apperr.KindRule {
		f.fail("_form", ae.Message)
		return true
	}
	return false
}

type leasePage struct {
	Detail  lease.Detail
	Balance money.Cents
	Options leaseFormOptions
}

func (s *Server) showLease(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(r, "id")
	if !ok {
		s.fail(w, r, errNotFound)
		return
	}
	s.renderLease(w, r, http.StatusOK, id, nil)
}

// renderLease shows a lease. A non-nil f re-fills the edit form with the
// submitted values and their errors.
func (s *Server) renderLease(w http.ResponseWriter, r *http.Request, status int, id pgtype.UUID, f *form) {
	d, err := s.leases.Get(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	balance, err := s.ledger.CurrentBalance(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	opts, err := s.leaseFormOptions(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	title := fmt.Sprintf("Lease %s %s", d.Property.Name, d.Unit.Label)
	v := s.newView(r, title, leasePage{Detail: d, Balance: balance, Options: opts})
	v.Form = leaseValues(d.Lease, d.Tenants)
	if f != nil {
		v.Form, v.Errors = f.values, f.errs.Map()
	}
	s.render(w, r, status, "lease.html", v)
}

func (s *Server) updateLease(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(r, "id")
	if !ok {
		s.fail(w, r, errNotFound)
		return
	}
	current, err := s.leases.Get(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	f, err := postForm(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	switch current.Lease.Status {
	case billing.LeaseDraft:
		terms := parseTerms(f)
		tenants := parseTenants(f)
		if f.err() == nil {
			_, err = s.leases.UpdateDraft(r.Context(), s.actor(r), id, terms, tenants)
		}
	case billing.LeaseActive:
		fees := parseFees(f)
		tenants := parseTenants(f)
		if f.err() == nil {
			_, err = s.leases.UpdateActive(r.Context(), s.actor(r), id, fees, tenants)
		}
	default:
		err = lease.ErrNotEditable
	}

	if err != nil && !ruleAsFormError(f, err) {
		s.fail(w, r, err)
		return
	}
	if f.err() != nil {
		s.renderLease(w, r, http.StatusUnprocessableEntity, id, f)
		return
	}
	s.flash(r, "Lease saved.")
	http.Redirect(w, r, "/leases/"+store.FormatUUID(id), http.StatusSeeOther)
}

func (s *Server) activateLease(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(r, "id")
	if !ok {
		s.fail(w, r, errNotFound)
		return
	}
	if _, err := s.leases.Activate(r.Context(), s.actor(r), id); err != nil {
		s.fail(w, r, err)
		return
	}
	s.flash(r, "Lease activated. Deposit and rent due to date have been posted.")
	http.Redirect(w, r, "/leases/"+store.FormatUUID(id), http.StatusSeeOther)
}

func (s *Server) deleteLease(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(r, "id")
	if !ok {
		s.fail(w, r, errNotFound)
		return
	}
	if err := s.leases.Delete(r.Context(), s.actor(r), id); err != nil {
		s.fail(w, r, err)
		return
	}
	s.flash(r, "Draft lease deleted.")
	http.Redirect(w, r, "/leases", http.StatusSeeOther)
}

type endPage struct {
	Detail  lease.Detail
	Preview *lease.EndPreview
	Key     string
}

func (s *Server) endLeaseForm(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(r, "id")
	if !ok {
		s.fail(w, r, errNotFound)
		return
	}
	f := queryForm(r)
	end := f.date("end_date", false)
	if end == nil {
		today := s.today()
		end = &today
	}
	s.renderEndLease(w, r, http.StatusOK, id, *end, f)
}

func (s *Server) renderEndLease(w http.ResponseWriter, r *http.Request, status int, id pgtype.UUID, end calendar.Date, f *form) {
	d, err := s.leases.Get(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	key, err := newFormKey()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	page := endPage{Detail: d, Key: key}
	if f.err() == nil {
		preview, err := s.leases.PreviewEnd(r.Context(), id, end)
		if err == nil {
			page.Preview = &preview
		} else if !ruleAsFormError(f, err) {
			s.fail(w, r, err)
			return
		}
	}
	v := s.newView(r, "End lease", page)
	v.Form.Set("end_date", end.String())
	if raw := f.raw("end_date"); raw != "" {
		v.Form.Set("end_date", raw)
	}
	v.Errors = f.errs.Map()
	if len(v.Errors) > 0 && status == http.StatusOK {
		status = http.StatusUnprocessableEntity
	}
	if isHTMX(r) {
		s.renderFragment(w, r, status, "lease_end.html", "end_preview", v)
		return
	}
	s.render(w, r, status, "lease_end.html", v)
}

func (s *Server) endLease(w http.ResponseWriter, r *http.Request) {
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
	end := f.date("end_date", true)
	postCredit := f.checked("post_credit")
	key := f.key("idempotency_key")
	if f.err() != nil {
		fallback := s.today()
		if end != nil {
			fallback = *end
		}
		s.renderEndLease(w, r, http.StatusUnprocessableEntity, id, fallback, f)
		return
	}

	res, err := s.leases.End(r.Context(), s.actor(r), id, lease.EndRequest{EndDate: *end, PostCredit: postCredit, Key: key})
	if err != nil {
		if ruleAsFormError(f, err) {
			s.renderEndLease(w, r, http.StatusUnprocessableEntity, id, *end, f)
			return
		}
		s.fail(w, r, err)
		return
	}
	msg := "Lease ended on " + end.String() + "."
	if res.Credit != nil {
		msg += " A credit of " + money.Cents(-res.Credit.AmountCents).String() + " was posted."
	}
	s.flash(r, msg)
	http.Redirect(w, r, "/leases/"+store.FormatUUID(id), http.StatusSeeOther)
}
