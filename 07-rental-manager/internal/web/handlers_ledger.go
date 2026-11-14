package web

import (
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5/pgtype"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/lease"
	"rentalmanager/internal/ledger"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

// statementRange reads from and to, defaulting to the whole history of the
// lease up to today.
func (s *Server) statementRange(f *form, l db.Lease) (from, to calendar.Date) {
	start := store.ToDate(l.StartDate)
	from, to = start, calendar.Max(s.today(), start)
	if d := f.date("from", false); d != nil {
		from = *d
	}
	if d := f.date("to", false); d != nil {
		to = *d
	}
	if to.Before(from) && !f.errs.Has("from") && !f.errs.Has("to") {
		f.fail("to", "must not be before the start of the range")
	}
	return from, to
}

type ledgerLine struct {
	ledger.StatementLine
	Reversible bool
}

type ledgerPage struct {
	Detail    lease.Detail
	Statement ledger.Statement
	Lines     []ledgerLine
	Key       string
	Notice    string
}

func (s *Server) reversible(u *auth.User, line ledger.StatementLine) bool {
	if u == nil || !u.Role.Can(auth.PermReverse) || line.Kind == billing.KindReversal || line.ReversedBy != 0 {
		return false
	}
	return u.Role == auth.RoleAdmin || calendar.DaysBetween(line.Date, s.today()) <= ledger.ManagerReversalDays
}

func (s *Server) showLedger(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(r, "id")
	if !ok {
		s.fail(w, r, errNotFound)
		return
	}
	s.renderLedger(w, r, http.StatusOK, id, queryForm(r), nil, "")
}

// renderLedger shows the statement page, or only its panel for htmx. The
// range comes from rangeForm; entryForm, when set, re-fills the entry form
// after a failed submission.
func (s *Server) renderLedger(w http.ResponseWriter, r *http.Request, status int, id pgtype.UUID, rangeForm, entryForm *form, notice string) {
	d, err := s.leases.Get(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	from, to := s.statementRange(rangeForm, d.Lease)
	if err := rangeForm.err(); err != nil {
		s.fail(w, r, err)
		return
	}
	st, err := s.ledger.Statement(r.Context(), id, from, to)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// A form shown again after a failed submission keeps its key, so the
	// corrected submission still posts at most once.
	var key string
	if entryForm != nil && !entryForm.errs.Has("idempotency_key") {
		key = entryForm.raw("idempotency_key")
	} else if key, err = newFormKey(); err != nil {
		s.fail(w, r, err)
		return
	}

	page := ledgerPage{Detail: d, Statement: st, Key: key, Notice: notice}
	user := currentUser(r)
	for _, line := range st.Lines {
		page.Lines = append(page.Lines, ledgerLine{StatementLine: line, Reversible: s.reversible(user, line)})
	}
	v := s.newView(r, "Ledger", page)
	v.Form.Set("kind", string(billing.KindPayment))
	v.Form.Set("entry_date", s.today().String())
	if entryForm != nil {
		v.Form, v.Errors = entryForm.values, entryForm.errs.Map()
	}
	if isHTMX(r) {
		s.renderFragment(w, r, status, "ledger.html", "ledger_panel", v)
		return
	}
	s.render(w, r, status, "ledger.html", v)
}

func (s *Server) ledgerURL(id pgtype.UUID) string {
	return "/leases/" + store.FormatUUID(id) + "/ledger"
}

func (s *Server) createEntry(w http.ResponseWriter, r *http.Request) {
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
	in := ledger.ManualEntry{
		LeaseID: id,
		Kind:    billing.Kind(f.choice("kind", string(billing.KindPayment), string(billing.KindCredit), string(billing.KindOtherCharge))),
		Memo:    f.text("memo", false, 200),
		Key:     f.key("idempotency_key"),
	}
	if c := f.amount("amount", true, true); c != nil {
		in.Amount = *c
	}
	if d := f.date("entry_date", true); d != nil {
		in.Date = *d
	}
	rangeForm := &form{values: f.values}

	if f.err() == nil {
		_, err := s.ledger.Record(r.Context(), s.actor(r), in)
		if err == nil {
			msg := in.Kind.Label() + " of " + in.Amount.String() + " recorded."
			if isHTMX(r) {
				s.renderLedger(w, r, http.StatusOK, id, rangeForm, nil, msg)
				return
			}
			s.flash(r, msg)
			http.Redirect(w, r, s.ledgerURL(id), http.StatusSeeOther)
			return
		}
		if !ruleAsFormError(f, err) {
			s.fail(w, r, err)
			return
		}
	}
	s.renderLedger(w, r, http.StatusUnprocessableEntity, id, rangeForm, f, "")
}

func (s *Server) reverseEntry(w http.ResponseWriter, r *http.Request) {
	id, ok := int64Param(r, "id")
	if !ok {
		s.fail(w, r, errNotFound)
		return
	}
	target, err := s.q.GetLedgerEntry(r.Context(), id)
	if store.IsNotFound(err) {
		s.fail(w, r, ledger.ErrEntryNotFound)
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	f, err := postForm(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	memo := f.text("memo", true, 200)
	if err := f.err(); err != nil {
		s.fail(w, r, err)
		return
	}

	if _, err := s.ledger.Reverse(r.Context(), s.actor(r), id, memo); err != nil {
		s.fail(w, r, err)
		return
	}
	msg := "Entry " + strconv.FormatInt(id, 10) + " reversed."
	if isHTMX(r) {
		s.renderLedger(w, r, http.StatusOK, target.LeaseID, &form{values: f.values}, nil, msg)
		return
	}
	s.flash(r, msg)
	http.Redirect(w, r, s.ledgerURL(target.LeaseID), http.StatusSeeOther)
}
