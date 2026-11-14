package web

import (
	"net/http"
	"time"

	"rentalmanager/internal/calendar"
	"rentalmanager/internal/ledger"
	"rentalmanager/internal/store"
)

type statementJSON struct {
	LeaseID             string              `json:"lease_id"`
	From                calendar.Date       `json:"from"`
	To                  calendar.Date       `json:"to"`
	OpeningBalanceCents int64               `json:"opening_balance_cents"`
	ClosingBalanceCents int64               `json:"closing_balance_cents"`
	Entries             []statementLineJSON `json:"entries"`
}

type statementLineJSON struct {
	ID                  int64         `json:"id"`
	EntryDate           calendar.Date `json:"entry_date"`
	Kind                string        `json:"kind"`
	AmountCents         int64         `json:"amount_cents"`
	Period              *string       `json:"period"`
	ReversesEntryID     *int64        `json:"reverses_entry_id"`
	ReversedByEntryID   *int64        `json:"reversed_by_entry_id"`
	Memo                string        `json:"memo"`
	RunningBalanceCents int64         `json:"running_balance_cents"`
	CreatedAt           time.Time     `json:"created_at"`
}

func optional[T comparable](v T) *T {
	var zero T
	if v == zero {
		return nil
	}
	return &v
}

func toStatementJSON(st ledger.Statement) statementJSON {
	out := statementJSON{
		LeaseID:             store.FormatUUID(st.Lease.ID),
		From:                st.From,
		To:                  st.To,
		OpeningBalanceCents: int64(st.Opening),
		ClosingBalanceCents: int64(st.Closing),
		Entries:             make([]statementLineJSON, 0, len(st.Lines)),
	}
	for _, l := range st.Lines {
		out.Entries = append(out.Entries, statementLineJSON{
			ID:                  l.ID,
			EntryDate:           l.Date,
			Kind:                string(l.Kind),
			AmountCents:         int64(l.Amount),
			Period:              optional(l.Period),
			ReversesEntryID:     optional(l.ReversesID),
			ReversedByEntryID:   optional(l.ReversedBy),
			Memo:                l.Memo,
			RunningBalanceCents: int64(l.Balance),
			CreatedAt:           l.CreatedAt.UTC(),
		})
	}
	return out
}

func (s *Server) apiStatement(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(r, "id")
	if !ok {
		s.fail(w, r, errNotFound)
		return
	}
	l, err := s.q.GetLease(r.Context(), id)
	if store.IsNotFound(err) {
		s.fail(w, r, ledger.ErrLeaseNotFound)
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	f := queryForm(r)
	from, to := s.statementRange(f, l)
	if err := f.err(); err != nil {
		s.fail(w, r, err)
		return
	}
	st, err := s.ledger.Statement(r.Context(), id, from, to)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.writeJSON(w, r, http.StatusOK, toStatementJSON(st))
}
