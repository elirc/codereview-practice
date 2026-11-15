package web

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5/pgtype"

	"rentalmanager/internal/apperr"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/ledger"
	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
)

// asOf reads the as_of query parameter: a date no later than today,
// defaulting to today.
func (s *Server) asOf(f *form) calendar.Date {
	today := s.today()
	d := f.date("as_of", false)
	if d == nil {
		return today
	}
	if d.After(today) {
		f.fail("as_of", "must not be later than today")
		return today
	}
	return *d
}

type rentRollPage struct {
	AsOf    calendar.Date
	Current bool
	Rows    []ledger.RentRollRow
	Rent    money.Cents
	Balance money.Cents
	Notice  string
	Error   string
}

func (s *Server) rentRoll(w http.ResponseWriter, r *http.Request) {
	f := queryForm(r)
	asOf := s.asOf(f)
	if err := f.err(); err != nil {
		s.fail(w, r, err)
		return
	}
	s.renderRentRoll(w, r, http.StatusOK, asOf, "", "")
}

// renderRentRoll shows the rent roll, or only its table for htmx.
func (s *Server) renderRentRoll(w http.ResponseWriter, r *http.Request, status int, asOf calendar.Date, notice, failure string) {
	rows, err := s.ledger.RentRoll(r.Context(), asOf)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	page := rentRollPage{AsOf: asOf, Current: asOf == s.today(), Rows: rows, Notice: notice, Error: failure}
	for _, row := range rows {
		page.Rent += row.Rent
		page.Balance += row.Balance
	}
	v := s.newView(r, "Rent roll", page)
	if isHTMX(r) {
		s.renderFragment(w, r, status, "rent_roll.html", "rent_roll_table", v)
		return
	}
	s.render(w, r, status, "rent_roll.html", v)
}

// rentRollPaymentKey is the idempotency key of a payment entered on the
// rent roll.
func rentRollPaymentKey(leaseID pgtype.UUID, on calendar.Date, amount money.Cents) string {
	return "rentroll:" + store.FormatUUID(leaseID) + ":" + on.String() + ":" + strconv.FormatInt(int64(amount), 10)
}

func (s *Server) recordRentRollPayment(w http.ResponseWriter, r *http.Request) {
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
	today := s.today()
	amount := f.amount("amount", true, true)
	if f.err() != nil {
		s.renderRentRoll(w, r, http.StatusUnprocessableEntity, today, "", "Amount "+f.errs.Map()["amount"]+".")
		return
	}

	_, err = s.ledger.Record(r.Context(), s.actor(r), ledger.ManualEntry{
		LeaseID: id,
		Kind:    billing.KindPayment,
		Amount:  *amount,
		Date:    today,
		Memo:    "Recorded from the rent roll",
		Key:     rentRollPaymentKey(id, today, *amount),
	})
	if err != nil {
		var ae *apperr.Error
		if errors.As(err, &ae) && ae.Kind == apperr.KindRule {
			s.renderRentRoll(w, r, http.StatusUnprocessableEntity, today, "", ae.Message)
			return
		}
		s.fail(w, r, err)
		return
	}
	msg := "Payment of " + amount.String() + " recorded."
	if isHTMX(r) {
		s.renderRentRoll(w, r, http.StatusOK, today, msg, "")
		return
	}
	s.flash(r, msg)
	http.Redirect(w, r, "/reports/rent-roll", http.StatusSeeOther)
}

func (s *Server) aging(w http.ResponseWriter, r *http.Request) {
	f := queryForm(r)
	asOf := s.asOf(f)
	if err := f.err(); err != nil {
		s.fail(w, r, err)
		return
	}
	report, err := s.ledger.Aging(r.Context(), asOf)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.render(w, r, http.StatusOK, "aging.html", s.newView(r, "Aged receivables", report))
}
