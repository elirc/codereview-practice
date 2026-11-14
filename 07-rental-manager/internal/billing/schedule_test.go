package billing

import (
	"testing"

	"rentalmanager/internal/calendar"
	"rentalmanager/internal/money"
)

func date(t *testing.T, s string) calendar.Date {
	t.Helper()
	d, err := calendar.Parse(s)
	if err != nil {
		t.Fatalf("calendar.Parse(%q): %v", s, err)
	}
	return d
}

func datePtr(t *testing.T, s string) *calendar.Date {
	t.Helper()
	d := date(t, s)
	return &d
}

func period(t *testing.T, s string) calendar.Period {
	t.Helper()
	p, err := calendar.ParsePeriod(s)
	if err != nil {
		t.Fatalf("calendar.ParsePeriod(%q): %v", s, err)
	}
	return p
}

type wantCharge struct {
	period string
	date   string
	amount money.Cents
	days   int
}

func TestSchedule(t *testing.T) {
	tests := []struct {
		name    string
		start   string
		end     string
		rent    money.Cents
		dueDay  int
		through string
		want    []wantCharge
	}{
		{
			name: "due day 31 clamps to month end", start: "2026-01-01", rent: 100000, dueDay: 31, through: "2026-04",
			want: []wantCharge{
				{"2026-01", "2026-01-31", 100000, 31},
				{"2026-02", "2026-02-28", 100000, 28},
				{"2026-03", "2026-03-31", 100000, 31},
				{"2026-04", "2026-04-30", 100000, 30},
			},
		},
		{
			name: "due day 31 in a leap year", start: "2024-01-01", rent: 100000, dueDay: 31, through: "2024-03",
			want: []wantCharge{
				{"2024-01", "2024-01-31", 100000, 31},
				{"2024-02", "2024-02-29", 100000, 29},
				{"2024-03", "2024-03-31", 100000, 31},
			},
		},
		{
			name: "due day 29 in a non-leap February", start: "2026-01-01", rent: 100000, dueDay: 29, through: "2026-03",
			want: []wantCharge{
				{"2026-01", "2026-01-29", 100000, 31},
				{"2026-02", "2026-02-28", 100000, 28},
				{"2026-03", "2026-03-29", 100000, 31},
			},
		},
		{
			name: "start on the 31st with due day 1", start: "2026-01-31", rent: 155000, dueDay: 1, through: "2026-02",
			want: []wantCharge{
				{"2026-01", "2026-01-31", 5000, 1},
				{"2026-02", "2026-02-01", 155000, 28},
			},
		},
		{
			name: "start mid February in a leap year", start: "2024-02-15", rent: 145000, dueDay: 1, through: "2024-03",
			want: []wantCharge{
				{"2024-02", "2024-02-15", 75000, 15},
				{"2024-03", "2024-03-01", 145000, 31},
			},
		},
		{
			name: "start on the 1st with due day 5", start: "2026-03-01", rent: 120000, dueDay: 5, through: "2026-04",
			want: []wantCharge{
				{"2026-03", "2026-03-05", 120000, 31},
				{"2026-04", "2026-04-05", 120000, 30},
			},
		},
		{
			name: "start after the due day", start: "2026-03-10", rent: 124000, dueDay: 5, through: "2026-04",
			want: []wantCharge{
				{"2026-03", "2026-03-10", 88000, 22},
				{"2026-04", "2026-04-05", 124000, 30},
			},
		},
		{
			name: "start before the due day", start: "2026-03-10", rent: 124000, dueDay: 20, through: "2026-04",
			want: []wantCharge{
				{"2026-03", "2026-03-20", 88000, 22},
				{"2026-04", "2026-04-20", 124000, 30},
			},
		},
		{
			name: "start and end in the same month", start: "2026-03-10", end: "2026-03-20", rent: 155000, dueDay: 1, through: "2026-06",
			want: []wantCharge{
				{"2026-03", "2026-03-10", 55000, 11},
			},
		},
		{
			name: "end on the last day of a month", start: "2026-01-01", end: "2026-03-31", rent: 100000, dueDay: 1, through: "2026-06",
			want: []wantCharge{
				{"2026-01", "2026-01-01", 100000, 31},
				{"2026-02", "2026-02-01", 100000, 28},
				{"2026-03", "2026-03-01", 100000, 31},
			},
		},
		{
			name: "end mid month prorates the final month", start: "2026-01-01", end: "2026-02-14", rent: 112000, dueDay: 1, through: "2026-06",
			want: []wantCharge{
				{"2026-01", "2026-01-01", 112000, 31},
				{"2026-02", "2026-02-01", 56000, 14},
			},
		},
		{
			name: "rounding of 10 of 31 days", start: "2026-01-22", rent: 100000, dueDay: 1, through: "2026-01",
			want: []wantCharge{
				{"2026-01", "2026-01-22", 32258, 10},
			},
		},
		{
			name: "rounding of 1 of 31 days", start: "2026-01-31", rent: 100001, dueDay: 1, through: "2026-01",
			want: []wantCharge{
				{"2026-01", "2026-01-31", 3226, 1},
			},
		},
		{
			name: "prorated amount rounding to zero is skipped", start: "2026-01-31", rent: 15, dueDay: 1, through: "2026-02",
			want: []wantCharge{
				{"2026-02", "2026-02-01", 15, 28},
			},
		},
		{
			name: "through before the start", start: "2026-05-01", rent: 100000, dueDay: 1, through: "2026-04",
			want: nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			terms := Terms{Start: date(t, tt.start), Rent: tt.rent, DueDay: tt.dueDay}
			if tt.end != "" {
				terms.End = datePtr(t, tt.end)
			}
			got := Schedule(terms, period(t, tt.through))
			if len(got) != len(tt.want) {
				t.Fatalf("got %d charges %+v, want %d", len(got), got, len(tt.want))
			}
			for i, w := range tt.want {
				c := got[i]
				if c.Period.String() != w.period || c.Date.String() != w.date || c.Amount != w.amount || c.Days != w.days {
					t.Errorf("charge %d = {%s %s %d %d days}, want {%s %s %d %d days}",
						i, c.Period, c.Date, c.Amount, c.Days, w.period, w.date, w.amount, w.days)
				}
				if c.Prorated() != (c.Days != c.DaysInMonth) || c.DaysInMonth != c.Period.Days() {
					t.Errorf("charge %d has inconsistent day counts: %+v", i, c)
				}
			}
		})
	}
}

func TestDueThroughUsesChargeDates(t *testing.T) {
	terms := Terms{Start: date(t, "2026-01-01"), Rent: 100000, DueDay: 1}

	got := DueThrough(terms, date(t, "2026-04-15"))
	wantDates := []string{"2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"}
	if len(got) != len(wantDates) {
		t.Fatalf("got %d charges, want %d", len(got), len(wantDates))
	}
	for i, w := range wantDates {
		if got[i].Date.String() != w {
			t.Errorf("charge %d dated %s, want %s", i, got[i].Date, w)
		}
	}

	if n := len(DueThrough(terms, date(t, "2026-02-28"))); n != 2 {
		t.Errorf("as of the last day of February: %d charges, want 2", n)
	}
	if n := len(DueThrough(terms, date(t, "2026-03-01"))); n != 3 {
		t.Errorf("as of the 1st of March: %d charges, want 3", n)
	}

	late := Terms{Start: date(t, "2026-03-01"), Rent: 100000, DueDay: 20}
	if n := len(DueThrough(late, date(t, "2026-03-19"))); n != 0 {
		t.Errorf("before the first due date: %d charges, want 0", n)
	}
}

func TestDueThroughStopsAtEndMonth(t *testing.T) {
	terms := Terms{Start: date(t, "2026-01-01"), End: datePtr(t, "2026-02-10"), Rent: 112000, DueDay: 15}
	got := DueThrough(terms, date(t, "2026-12-31"))
	if len(got) != 2 {
		t.Fatalf("got %d charges, want 2", len(got))
	}
	if got[1].Period.String() != "2026-02" || got[1].Date.String() != "2026-02-15" || got[1].Amount != 40000 {
		t.Errorf("final charge = %+v", got[1])
	}
}

func TestSuggestEndCredit(t *testing.T) {
	posted := []PostedRent{
		{Period: period(t, "2026-02"), Amount: 310000},
		{Period: period(t, "2026-03"), Amount: 310000},
		{Period: period(t, "2026-04"), Amount: 310000},
	}
	terms := Terms{Start: date(t, "2026-02-01"), End: datePtr(t, "2026-03-10"), Rent: 310000, DueDay: 1}

	got := SuggestEndCredit(terms, posted)
	if got.Total != 210000+310000 {
		t.Fatalf("Total = %d, want %d", got.Total, 210000+310000)
	}
	if len(got.Lines) != 2 {
		t.Fatalf("Lines = %+v", got.Lines)
	}
	if got.Lines[0].Period.String() != "2026-03" || got.Lines[0].Due != 100000 {
		t.Errorf("March line = %+v", got.Lines[0])
	}
	if got.Lines[1].Period.String() != "2026-04" || got.Lines[1].Due != 0 {
		t.Errorf("April line = %+v", got.Lines[1])
	}

	unchanged := SuggestEndCredit(Terms{Start: date(t, "2026-02-01"), End: datePtr(t, "2026-04-30"), Rent: 310000, DueDay: 1}, posted)
	if unchanged.Total != 0 || len(unchanged.Lines) != 0 {
		t.Errorf("full final month should need no credit, got %+v", unchanged)
	}
}
