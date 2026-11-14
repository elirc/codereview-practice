package web

import (
	"net/http"

	"rentalmanager/internal/calendar"
	"rentalmanager/internal/ledger"
	"rentalmanager/internal/money"
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
	Rows    []ledger.RentRollRow
	Rent    money.Cents
	Balance money.Cents
}

func (s *Server) rentRoll(w http.ResponseWriter, r *http.Request) {
	f := queryForm(r)
	asOf := s.asOf(f)
	if err := f.err(); err != nil {
		s.fail(w, r, err)
		return
	}
	rows, err := s.ledger.RentRoll(r.Context(), asOf)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	page := rentRollPage{AsOf: asOf, Rows: rows}
	for _, row := range rows {
		page.Rent += row.Rent
		page.Balance += row.Balance
	}
	s.render(w, r, http.StatusOK, "rent_roll.html", s.newView(r, "Rent roll", page))
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
