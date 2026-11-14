package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/ledger"
	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

type seedUser struct {
	email    string
	name     string
	password string
	role     auth.Role
}

// The admin is checked first: when it exists the database is already seeded.
var seedUsers = []seedUser{
	{"admin@example.com", "Avery Admin", "admin-password-1", auth.RoleAdmin},
	{"manager@example.com", "Morgan Manager", "manager-password-1", auth.RoleManager},
	{"viewer@example.com", "Val Viewer", "viewer-password-1", auth.RoleViewer},
}

func runSeed(ctx context.Context, a *app, args []string) error {
	if len(args) > 0 {
		return errors.New("seed takes no arguments")
	}
	pool, err := store.Open(ctx, a.cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	clock := calendar.SystemClock{}
	seeded := false
	err = store.WithTx(ctx, pool, func(q *db.Queries) error {
		switch _, err := q.GetUserByEmail(ctx, seedUsers[0].email); {
		case err == nil:
			return nil
		case !store.IsNotFound(err):
			return fmt.Errorf("checking for seed data: %w", err)
		}
		seeded = true
		s := &seeder{ctx: ctx, q: q, now: clock.Now(), today: calendar.Today(clock, a.cfg.Location)}
		return s.run()
	})
	if err != nil {
		return fmt.Errorf("seeding: %w", err)
	}
	if seeded {
		a.log.Info("seed data created")
	} else {
		a.log.Info("seed data already present; nothing to do")
	}
	return nil
}

type seeder struct {
	ctx      context.Context
	q        *db.Queries
	now      time.Time
	today    calendar.Date
	payments int
}

// monthsAgo returns the period k months before the current one.
func (s *seeder) monthsAgo(k int) calendar.Period {
	p := s.today.Period()
	for i := 0; i < k; i++ {
		if p.Month == time.January {
			p = calendar.Period{Year: p.Year - 1, Month: time.December}
		} else {
			p = calendar.Period{Year: p.Year, Month: p.Month - 1}
		}
	}
	return p
}

func (s *seeder) run() error {
	for _, u := range seedUsers {
		hash, err := auth.HashPassword(u.password, auth.BcryptCost)
		if err != nil {
			return err
		}
		if _, err := s.q.CreateUser(s.ctx, db.CreateUserParams{Email: u.email, PasswordHash: hash, Name: u.name, Role: string(u.role)}); err != nil {
			return fmt.Errorf("creating user %s: %w", u.email, err)
		}
	}

	maple, err := s.property("Maple Court", "120 Maple Ave, Springfield")
	if err != nil {
		return err
	}
	oak, err := s.property("Oak Street Duplex", "48 Oak St, Springfield")
	if err != nil {
		return err
	}
	units := map[string]pgtype.UUID{}
	for _, u := range []struct {
		property pgtype.UUID
		label    string
		beds     int32
		rent     int64
	}{
		{maple, "1A", 2, 145000}, {maple, "1B", 1, 120000}, {maple, "2A", 2, 150000},
		{oak, "Upper", 3, 185000}, {oak, "Lower", 2, 99500},
	} {
		unit, err := s.q.CreateUnit(s.ctx, db.CreateUnitParams{PropertyID: u.property, Label: u.label, Bedrooms: u.beds, MarketRentCents: u.rent})
		if err != nil {
			return fmt.Errorf("creating unit %s: %w", u.label, err)
		}
		units[u.label] = unit.ID
	}

	tenants := map[string]pgtype.UUID{}
	for _, name := range []string{"Jordan Lee", "Sam Rivera", "Priya Patel", "Chris Okafor", "Dana Kim", "Alex Novak", "Riley Chen"} {
		t, err := s.q.CreateTenant(s.ctx, db.CreateTenantParams{FullName: name, Email: store.Text(emailFor(name))})
		if err != nil {
			return fmt.Errorf("creating tenant %s: %w", name, err)
		}
		tenants[name] = t.ID
	}

	// Paid on time every month except the current one.
	onTime, err := s.lease(leaseSeed{
		unit: units["1A"], tenants: []pgtype.UUID{tenants["Jordan Lee"], tenants["Sam Rivera"]},
		start: s.monthsAgo(5).First(), rent: 145000, dueDay: 1, grace: 5,
		fee: billing.FeeFlat, flat: 5000, deposit: 145000,
	})
	if err != nil {
		return err
	}
	if err := s.pay(onTime, s.monthsAgo(5).First(), 145000, "Deposit, check 1001"); err != nil {
		return err
	}
	for k := 5; k >= 1; k-- {
		if err := s.pay(onTime, s.monthsAgo(k).DueDate(3), 145000, "Rent "+s.monthsAgo(k).String()); err != nil {
			return err
		}
	}

	// Mid-month start, then a partial late payment that draws a capped percent fee.
	cappedAt := money.Cents(5000)
	partial, err := s.lease(leaseSeed{
		unit: units["1B"], tenants: []pgtype.UUID{tenants["Priya Patel"]},
		start: s.monthsAgo(3).DueDate(15), rent: 120000, dueDay: 1, grace: 5,
		fee: billing.FeePercent, bps: 500, cap: &cappedAt, deposit: 60000,
	})
	if err != nil {
		return err
	}
	first, _ := billing.ChargeFor(ledger.TermsOf(partial), s.monthsAgo(3))
	if err := s.pay(partial, s.monthsAgo(3).DueDate(15), 60000+first.Amount, "Deposit and first month"); err != nil {
		return err
	}
	if err := s.pay(partial, s.monthsAgo(2).DueDate(10), 60000, "Partial payment"); err != nil {
		return err
	}
	if err := s.pay(partial, s.monthsAgo(1).DueDate(2), 120000, "Rent "+s.monthsAgo(1).String()); err != nil {
		return err
	}

	if _, err := s.createLease(leaseSeed{
		unit: units["2A"], tenants: []pgtype.UUID{tenants["Chris Okafor"]},
		start: s.today.Period().Next().First(), rent: 150000, dueDay: 1, grace: 5,
		fee: billing.FeeFlat, flat: 5000, deposit: 150000,
	}); err != nil {
		return err
	}

	// A lease that ended last month with its final month unpaid, followed
	// by a new lease on the same unit.
	lastDay := s.monthsAgo(1).Last()
	ended, err := s.lease(leaseSeed{
		unit: units["Upper"], tenants: []pgtype.UUID{tenants["Dana Kim"]},
		start: s.monthsAgo(4).First(), end: &lastDay, rent: 180000, dueDay: 5, grace: 3,
		fee: billing.FeeFlat, flat: 7500, deposit: 180000,
	})
	if err != nil {
		return err
	}
	for k := 4; k >= 2; k-- {
		if err := s.pay(ended, s.monthsAgo(k).DueDate(5), 180000, "Rent "+s.monthsAgo(k).String()); err != nil {
			return err
		}
	}
	if _, err := s.q.EndLease(s.ctx, db.EndLeaseParams{ID: ended.ID, EndDate: store.Date(lastDay), EndedAt: store.Timestamptz(s.now)}); err != nil {
		return fmt.Errorf("ending seed lease: %w", err)
	}
	newUpper, err := s.lease(leaseSeed{
		unit: units["Upper"], tenants: []pgtype.UUID{tenants["Alex Novak"]},
		start: s.today.Period().First(), rent: 185000, dueDay: 1, grace: 5,
		fee: billing.FeeFlat, flat: 5000, deposit: 185000,
	})
	if err != nil {
		return err
	}

	// Overpays each month and carries a credit balance.
	credit, err := s.lease(leaseSeed{
		unit: units["Lower"], tenants: []pgtype.UUID{tenants["Riley Chen"]},
		start: s.monthsAgo(2).First(), rent: 99500, dueDay: 1, grace: 5, fee: billing.FeeNone,
	})
	if err != nil {
		return err
	}
	for k := 2; k >= 0; k-- {
		day := s.monthsAgo(k).First()
		if day.After(s.today) {
			continue
		}
		if err := s.pay(credit, day, 110000, "Autopay"); err != nil {
			return err
		}
	}

	for _, l := range []db.Lease{onTime, partial, ended, newUpper, credit} {
		current, err := s.q.GetLease(s.ctx, l.ID)
		if err != nil {
			return err
		}
		if _, err := ledger.AssessLateFees(s.ctx, s.q, current, s.today); err != nil {
			return err
		}
	}
	return nil
}

func emailFor(name string) string {
	b := []byte(name)
	for i, c := range b {
		switch {
		case c == ' ':
			b[i] = '.'
		case c >= 'A' && c <= 'Z':
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b) + "@example.net"
}

func (s *seeder) property(name, address string) (pgtype.UUID, error) {
	p, err := s.q.CreateProperty(s.ctx, db.CreatePropertyParams{Name: name, Address: address})
	if err != nil {
		return pgtype.UUID{}, fmt.Errorf("creating property %s: %w", name, err)
	}
	return p.ID, nil
}

type leaseSeed struct {
	unit    pgtype.UUID
	tenants []pgtype.UUID
	start   calendar.Date
	end     *calendar.Date
	rent    money.Cents
	dueDay  int
	grace   int
	fee     billing.FeeKind
	flat    money.Cents
	bps     int
	cap     *money.Cents
	deposit money.Cents
}

func (s *seeder) createLease(in leaseSeed) (db.Lease, error) {
	params := db.CreateLeaseParams{
		UnitID:           in.unit,
		StartDate:        store.Date(in.start),
		EndDate:          store.OptionalDate(in.end),
		RentCents:        int64(in.rent),
		DueDay:           int32(in.dueDay),
		GraceDays:        int32(in.grace),
		LateFeeKind:      string(in.fee),
		LateFeeFlatCents: int64(in.flat),
		LateFeeBps:       int32(in.bps),
		DepositCents:     int64(in.deposit),
	}
	if in.cap != nil {
		params.LateFeeCapCents = store.Int8(int64(*in.cap))
	}
	l, err := s.q.CreateLease(s.ctx, params)
	if err != nil {
		return db.Lease{}, fmt.Errorf("creating seed lease: %w", err)
	}
	for i, t := range in.tenants {
		if err := s.q.AddLeaseTenant(s.ctx, db.AddLeaseTenantParams{LeaseID: l.ID, TenantID: t, IsPrimary: i == 0}); err != nil {
			return db.Lease{}, fmt.Errorf("adding seed tenant: %w", err)
		}
	}
	return l, nil
}

// lease creates and activates a lease, posting its deposit and the rent due
// to date as activation does.
func (s *seeder) lease(in leaseSeed) (db.Lease, error) {
	l, err := s.createLease(in)
	if err != nil {
		return db.Lease{}, err
	}
	l, err = s.q.ActivateLease(s.ctx, db.ActivateLeaseParams{ID: l.ID, ActivatedAt: store.Timestamptz(s.now)})
	if err != nil {
		return db.Lease{}, fmt.Errorf("activating seed lease: %w", err)
	}
	if _, err := ledger.PostDeposit(s.ctx, s.q, l); err != nil {
		return db.Lease{}, err
	}
	if _, err := ledger.PostRent(s.ctx, s.q, l, s.today); err != nil {
		return db.Lease{}, err
	}
	return l, nil
}

func (s *seeder) pay(l db.Lease, on calendar.Date, amount money.Cents, memo string) error {
	if on.After(s.today) {
		return nil
	}
	s.payments++
	_, _, err := ledger.Post(s.ctx, s.q, ledger.Posting{
		LeaseID: l.ID,
		Date:    on,
		Kind:    billing.KindPayment,
		Amount:  -amount,
		Key:     fmt.Sprintf("seed:payment:%d", s.payments),
		Memo:    memo,
	})
	return err
}
