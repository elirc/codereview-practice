package web_test

import (
	"context"
	"encoding/json"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/config"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
	"rentalmanager/internal/testdb"
	"rentalmanager/internal/web"
)

const (
	today    = "2026-03-15"
	password = "correct-horse-battery"
)

type harness struct {
	t   *testing.T
	f   *testdb.Fixture
	srv *httptest.Server
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	f := testdb.New(t)
	cfg := config.Config{
		DatabaseURL: "postgres://unused",
		HTTPAddr:    ":0",
		Env:         config.EnvTest,
		Location:    testdb.Chicago,
		LogLevel:    slog.LevelError,
	}
	s, err := web.New(web.Options{
		Config:     cfg,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Pool:       f.Pool,
		Clock:      testdb.ClockAt(t, today),
		BcryptCost: bcrypt.MinCost,
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)

	hash, err := auth.HashPassword(password, bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	for _, role := range auth.Roles {
		_, err := f.Q.CreateUser(context.Background(), db.CreateUserParams{
			Email:        string(role) + "@example.test",
			PasswordHash: hash,
			Name:         "Test " + string(role),
			Role:         string(role),
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return &harness{t: t, f: f, srv: srv}
}

type client struct {
	t    *testing.T
	base string
	page string
	hc   *http.Client
}

func (h *harness) client() *client {
	jar, err := cookiejar.New(nil)
	if err != nil {
		h.t.Fatal(err)
	}
	return &client{
		t:    h.t,
		base: h.srv.URL,
		page: "/login",
		hc: &http.Client{
			Jar:           jar,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

func (h *harness) as(role auth.Role) *client {
	c := h.client()
	c.login(string(role)+"@example.test", password, http.StatusSeeOther)
	return c
}

// on returns a copy of c that reports failures to t, for use in subtests.
func (c *client) on(t *testing.T) *client {
	cp := *c
	cp.t = t
	return &cp
}

func (c *client) do(method, path string, form url.Values, header http.Header) (*http.Response, string) {
	c.t.Helper()
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequest(method, c.base+path, body)
	if err != nil {
		c.t.Fatal(err)
	}
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	for k, vs := range header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		c.t.Fatal(err)
	}
	if err := resp.Body.Close(); err != nil {
		c.t.Fatal(err)
	}
	return resp, string(b)
}

var csrfField = regexp.MustCompile(`name="csrf_token" value="([^"]+)"`)

func (c *client) token() string {
	c.t.Helper()
	resp, body := c.do(http.MethodGet, c.page, nil, nil)
	m := csrfField.FindStringSubmatch(body)
	if m == nil {
		c.t.Fatalf("no csrf token on %s (status %d)", c.page, resp.StatusCode)
	}
	return html.UnescapeString(m[1])
}

func (c *client) post(path string, form url.Values) (*http.Response, string) {
	c.t.Helper()
	if form == nil {
		form = url.Values{}
	}
	form.Set("csrf_token", c.token())
	return c.do(http.MethodPost, path, form, nil)
}

func (c *client) login(email, pw string, want int) {
	c.t.Helper()
	resp, body := c.post("/login", url.Values{"email": {email}, "password": {pw}})
	if resp.StatusCode != want {
		c.t.Fatalf("login as %s: status %d, want %d\n%s", email, resp.StatusCode, want, body)
	}
	if want == http.StatusSeeOther {
		c.page = "/"
	}
}

func newKey(t *testing.T) string {
	t.Helper()
	u, err := store.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return store.FormatUUID(u)
}

func TestWriteRoutesEnforceRoles(t *testing.T) {
	h := newHarness(t)
	unit := h.f.Unit()
	l := h.f.ActiveLease(testdb.LeaseOptions{})
	leaseID := store.FormatUUID(l.ID)
	targets := map[auth.Role]string{}
	for _, role := range auth.Roles {
		e := h.f.Insert(l.ID, billing.KindOtherCharge, "2026-03-01", 2500, "")
		targets[role] = "/entries/" + strconv.FormatInt(e.ID, 10) + "/reverse"
	}

	tests := []struct {
		name   string
		method string
		path   func(auth.Role) string
		form   func(auth.Role) url.Values
		want   map[auth.Role]int
	}{
		{
			name: "create property", method: http.MethodPost,
			path: fixed("/properties"),
			form: func(auth.Role) url.Values { return url.Values{"name": {"Elm Court"}, "address": {"9 Elm St"}} },
			want: map[auth.Role]int{auth.RoleViewer: 403, auth.RoleManager: 303, auth.RoleAdmin: 303},
		},
		{
			name: "create tenant", method: http.MethodPost,
			path: fixed("/tenants"),
			form: func(auth.Role) url.Values { return url.Values{"full_name": {"Ada Byron"}} },
			want: map[auth.Role]int{auth.RoleViewer: 403, auth.RoleManager: 303, auth.RoleAdmin: 303},
		},
		{
			name: "new lease form", method: http.MethodGet,
			path: fixed("/leases/new"),
			want: map[auth.Role]int{auth.RoleViewer: 403, auth.RoleManager: 200, auth.RoleAdmin: 200},
		},
		{
			name: "create lease", method: http.MethodPost,
			path: fixed("/leases"),
			form: func(auth.Role) url.Values {
				return url.Values{
					"unit_id": {store.FormatUUID(unit.ID)}, "start_date": {"2027-01-01"}, "rent": {"1000"},
					"due_day": {"1"}, "grace_days": {"5"}, "late_fee_kind": {"none"}, "deposit": {"0"},
				}
			},
			want: map[auth.Role]int{auth.RoleViewer: 403, auth.RoleManager: 303, auth.RoleAdmin: 303},
		},
		{
			name: "record payment", method: http.MethodPost,
			path: fixed("/leases/" + leaseID + "/entries"),
			form: func(auth.Role) url.Values {
				return url.Values{"kind": {"payment"}, "amount": {"10"}, "entry_date": {today}, "idempotency_key": {newKey(t)}}
			},
			want: map[auth.Role]int{auth.RoleViewer: 403, auth.RoleManager: 303, auth.RoleAdmin: 303},
		},
		{
			name: "reverse entry", method: http.MethodPost,
			path: func(r auth.Role) string { return targets[r] },
			form: func(auth.Role) url.Values { return url.Values{"memo": {"entered twice"}} },
			want: map[auth.Role]int{auth.RoleViewer: 403, auth.RoleManager: 303, auth.RoleAdmin: 303},
		},
		{
			name: "run job", method: http.MethodPost,
			path: fixed("/admin/jobs/post-rent/run"),
			form: func(auth.Role) url.Values { return url.Values{"as_of": {today}} },
			want: map[auth.Role]int{auth.RoleViewer: 403, auth.RoleManager: 403, auth.RoleAdmin: 303},
		},
		{
			name: "view job runs", method: http.MethodGet,
			path: fixed("/admin/jobs"),
			want: map[auth.Role]int{auth.RoleViewer: 403, auth.RoleManager: 403, auth.RoleAdmin: 200},
		},
		{
			name: "create user", method: http.MethodPost,
			path: fixed("/admin/users"),
			form: func(r auth.Role) url.Values {
				return url.Values{"email": {"new-" + string(r) + "@example.test"}, "name": {"New"}, "role": {"viewer"}, "password": {"long-enough-password"}}
			},
			want: map[auth.Role]int{auth.RoleViewer: 403, auth.RoleManager: 403, auth.RoleAdmin: 303},
		},
		{
			name: "view users", method: http.MethodGet,
			path: fixed("/admin/users"),
			want: map[auth.Role]int{auth.RoleViewer: 403, auth.RoleManager: 403, auth.RoleAdmin: 200},
		},
	}

	clients := map[auth.Role]*client{}
	for _, role := range auth.Roles {
		clients[role] = h.as(role)
	}
	for _, tt := range tests {
		for _, role := range auth.Roles {
			t.Run(tt.name+" as "+string(role), func(t *testing.T) {
				c := clients[role].on(t)
				var resp *http.Response
				var body string
				if tt.method == http.MethodGet {
					resp, body = c.do(http.MethodGet, tt.path(role), nil, nil)
				} else {
					resp, body = c.post(tt.path(role), tt.form(role))
				}
				if resp.StatusCode != tt.want[role] {
					t.Fatalf("status %d, want %d\n%s", resp.StatusCode, tt.want[role], body)
				}
			})
		}
	}
}

func fixed(path string) func(auth.Role) string {
	return func(auth.Role) string { return path }
}

func TestUnauthenticatedRequests(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	l := h.f.ActiveLease(testdb.LeaseOptions{})

	resp, _ := c.do(http.MethodGet, "/", nil, nil)
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != "/login" {
		t.Errorf("page: status %d location %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	resp, _ = c.do(http.MethodGet, "/leases", nil, http.Header{"Hx-Request": {"true"}})
	if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("HX-Redirect") != "/login" {
		t.Errorf("htmx: status %d HX-Redirect %q", resp.StatusCode, resp.Header.Get("HX-Redirect"))
	}
	resp, body := c.do(http.MethodGet, "/api/leases/"+store.FormatUUID(l.ID)+"/statement", nil, nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("api: status %d", resp.StatusCode)
	}
	if env := decodeEnvelope(t, body); env.Error.Code != "unauthenticated" || env.Error.RequestID == "" {
		t.Errorf("api envelope = %+v", env)
	}
}

func TestLogin(t *testing.T) {
	h := newHarness(t)
	h.client().login("manager@example.test", "wrong-password", http.StatusUnauthorized)
	h.client().login("nobody@example.test", password, http.StatusUnauthorized)
	h.client().login("", "", http.StatusUnprocessableEntity)

	deactivate := "UPDATE users SET active = false WHERE email = 'viewer@example.test'"
	if _, err := h.f.Pool.Exec(context.Background(), deactivate); err != nil {
		t.Fatal(err)
	}
	h.client().login("viewer@example.test", password, http.StatusUnauthorized)

	c := h.as(auth.RoleManager)
	if resp, _ := c.do(http.MethodGet, "/", nil, nil); resp.StatusCode != http.StatusOK {
		t.Errorf("dashboard after login: status %d", resp.StatusCode)
	}
	if resp, _ := c.post("/logout", nil); resp.StatusCode != http.StatusSeeOther {
		t.Errorf("logout: status %d", resp.StatusCode)
	}
	if resp, _ := c.do(http.MethodGet, "/", nil, nil); resp.StatusCode != http.StatusSeeOther {
		t.Errorf("dashboard after logout: status %d", resp.StatusCode)
	}
}

func TestStateChangingRequestsRequireCSRFToken(t *testing.T) {
	h := newHarness(t)
	c := h.as(auth.RoleManager)
	form := func() url.Values { return url.Values{"name": {"Birch House"}, "address": {"2 Birch Rd"}} }

	if resp, _ := c.do(http.MethodPost, "/properties", form(), nil); resp.StatusCode != http.StatusForbidden {
		t.Errorf("without token: status %d, want 403", resp.StatusCode)
	}
	forged := form()
	forged.Set("csrf_token", "forged")
	if resp, _ := c.do(http.MethodPost, "/properties", forged, nil); resp.StatusCode != http.StatusForbidden {
		t.Errorf("with a forged token: status %d, want 403", resp.StatusCode)
	}
	headers := http.Header{"X-Csrf-Token": {c.token()}}
	if resp, _ := c.do(http.MethodPost, "/properties", form(), headers); resp.StatusCode != http.StatusSeeOther {
		t.Errorf("with the htmx header token: status %d, want 303", resp.StatusCode)
	}
	if resp, _ := c.post("/properties", form()); resp.StatusCode != http.StatusSeeOther {
		t.Errorf("with the form token: status %d, want 303", resp.StatusCode)
	}

	anon := h.client()
	creds := url.Values{"email": {"manager@example.test"}, "password": {password}}
	if resp, _ := anon.do(http.MethodPost, "/login", creds, nil); resp.StatusCode != http.StatusForbidden {
		t.Errorf("login without token: status %d, want 403", resp.StatusCode)
	}
}

func TestManualEntryValidation(t *testing.T) {
	h := newHarness(t)
	c := h.as(auth.RoleManager)
	l := h.f.ActiveLease(testdb.LeaseOptions{})
	path := "/leases/" + store.FormatUUID(l.ID) + "/entries"

	invalid := []struct {
		name string
		form url.Values
	}{
		{"three decimals", url.Values{"amount": {"12.345"}}},
		{"negative", url.Values{"amount": {"-5"}}},
		{"zero", url.Values{"amount": {"0"}}},
		{"exponent", url.Values{"amount": {"1e3"}}},
		{"thousands separator", url.Values{"amount": {"1,000.00"}}},
		{"empty", url.Values{"amount": {""}}},
		{"rent is not a manual kind", url.Values{"amount": {"10"}, "kind": {"rent"}}},
		{"missing key", url.Values{"amount": {"10"}, "idempotency_key": {""}}},
		{"malformed date", url.Values{"amount": {"10"}, "entry_date": {"03/01/2026"}}},
		{"future date", url.Values{"amount": {"10"}, "entry_date": {"2026-03-16"}}},
	}
	for _, tt := range invalid {
		t.Run(tt.name, func(t *testing.T) {
			form := url.Values{"kind": {"payment"}, "entry_date": {today}, "idempotency_key": {newKey(t)}}
			for k, v := range tt.form {
				form[k] = v
			}
			resp, body := c.on(t).post(path, form)
			if resp.StatusCode != http.StatusUnprocessableEntity {
				t.Fatalf("status %d, want 422\n%s", resp.StatusCode, body)
			}
			if !strings.Contains(body, `class="field-error"`) {
				t.Error("response does not show a field error")
			}
		})
	}
	if n := len(h.f.Entries(l.ID)); n != 0 {
		t.Fatalf("invalid submissions posted %d entries", n)
	}

	valid := []struct {
		amount string
		want   int64
	}{
		{"1000", -100000},
		{"1000.5", -100050},
	}
	for _, tt := range valid {
		form := url.Values{"kind": {"payment"}, "amount": {tt.amount}, "entry_date": {today}, "idempotency_key": {newKey(t)}}
		if resp, body := c.post(path, form); resp.StatusCode != http.StatusSeeOther {
			t.Fatalf("amount %q: status %d\n%s", tt.amount, resp.StatusCode, body)
		}
		entries := h.f.Entries(l.ID)
		if got := entries[len(entries)-1].AmountCents; got != tt.want {
			t.Errorf("amount %q stored as %d, want %d", tt.amount, got, tt.want)
		}
	}
}

func TestDoubleSubmittedPaymentPostsOnce(t *testing.T) {
	h := newHarness(t)
	c := h.as(auth.RoleManager)
	l := h.f.ActiveLease(testdb.LeaseOptions{})
	path := "/leases/" + store.FormatUUID(l.ID) + "/entries"
	key := newKey(t)
	form := func() url.Values {
		return url.Values{"kind": {"payment"}, "amount": {"500"}, "entry_date": {today}, "idempotency_key": {key}}
	}

	for i := 0; i < 2; i++ {
		if resp, body := c.post(path, form()); resp.StatusCode != http.StatusSeeOther {
			t.Fatalf("submission %d: status %d\n%s", i, resp.StatusCode, body)
		}
	}
	headers := http.Header{"Hx-Request": {"true"}, "X-Csrf-Token": {c.token()}}
	resp, body := c.do(http.MethodPost, path, form(), headers)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `id="ledger-panel"`) {
		t.Fatalf("htmx resubmission: status %d", resp.StatusCode)
	}
	if n := len(h.f.Entries(l.ID)); n != 1 {
		t.Fatalf("ledger has %d entries, want 1", n)
	}
}

func TestReversalErrorsMapToStatuses(t *testing.T) {
	h := newHarness(t)
	manager := h.as(auth.RoleManager)
	l := h.f.ActiveLease(testdb.LeaseOptions{})
	old := h.f.Insert(l.ID, billing.KindOtherCharge, "2026-01-02", 2500, "")
	recent := h.f.Insert(l.ID, billing.KindOtherCharge, "2026-03-02", 2500, "")
	reversePath := func(id int64) string { return "/entries/" + strconv.FormatInt(id, 10) + "/reverse" }
	memo := func() url.Values { return url.Values{"memo": {"entered twice"}} }

	if resp, _ := manager.post(reversePath(old.ID), memo()); resp.StatusCode != http.StatusForbidden {
		t.Errorf("manager reversing a 72-day-old entry: status %d, want 403", resp.StatusCode)
	}
	if resp, _ := manager.post(reversePath(recent.ID), nil); resp.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("reversal without memo: status %d, want 422", resp.StatusCode)
	}
	if resp, _ := manager.post(reversePath(recent.ID), memo()); resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("first reversal: status %d", resp.StatusCode)
	}
	resp, body := manager.post(reversePath(recent.ID), memo())
	if resp.StatusCode != http.StatusConflict || !strings.Contains(body, "already_reversed") {
		t.Errorf("second reversal: status %d, want 409 already_reversed", resp.StatusCode)
	}
	if resp, _ := manager.post("/entries/not-a-number/reverse", memo()); resp.StatusCode != http.StatusNotFound {
		t.Errorf("malformed entry id: status %d, want 404", resp.StatusCode)
	}
	if resp, _ := manager.do(http.MethodGet, "/leases/not-a-uuid", nil, nil); resp.StatusCode != http.StatusNotFound {
		t.Errorf("malformed lease id: status %d, want 404", resp.StatusCode)
	}
}

func TestActivatingOverlappingLeaseReportsUnitOccupied(t *testing.T) {
	h := newHarness(t)
	c := h.as(auth.RoleManager)
	unit := h.f.Unit()
	h.f.ActiveLease(testdb.LeaseOptions{UnitID: unit.ID, Start: "2026-01-01"})
	draft := h.f.DraftLease(testdb.LeaseOptions{UnitID: unit.ID, Start: "2026-06-01"})

	resp, body := c.post("/leases/"+store.FormatUUID(draft.ID)+"/activate", nil)
	if resp.StatusCode != http.StatusConflict || !strings.Contains(body, "unit_occupied") {
		t.Fatalf("status %d, want 409 unit_occupied", resp.StatusCode)
	}
}

type envelope struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"requestId"`
		Details   struct {
			Fields []struct {
				Path    string `json:"path"`
				Message string `json:"message"`
			} `json:"fields"`
		} `json:"details"`
	} `json:"error"`
}

func decodeEnvelope(t *testing.T, body string) envelope {
	t.Helper()
	var env envelope
	if err := json.Unmarshal([]byte(body), &env); err != nil {
		t.Fatalf("decoding error envelope %q: %v", body, err)
	}
	return env
}

type statementLine struct {
	ID      int64   `json:"id"`
	Date    string  `json:"entry_date"`
	Kind    string  `json:"kind"`
	Amount  int64   `json:"amount_cents"`
	Period  *string `json:"period"`
	Running int64   `json:"running_balance_cents"`
	Created string  `json:"created_at"`
}

type statement struct {
	LeaseID string          `json:"lease_id"`
	From    string          `json:"from"`
	To      string          `json:"to"`
	Opening int64           `json:"opening_balance_cents"`
	Closing int64           `json:"closing_balance_cents"`
	Entries []statementLine `json:"entries"`
}

func TestStatementJSON(t *testing.T) {
	h := newHarness(t)
	c := h.as(auth.RoleViewer)
	l := h.f.ActiveLease(testdb.LeaseOptions{})
	h.f.Insert(l.ID, billing.KindRent, "2026-01-01", 100000, "2026-01")
	h.f.Insert(l.ID, billing.KindPayment, "2026-01-05", -60000, "")
	rent := h.f.Insert(l.ID, billing.KindRent, "2026-02-01", 100000, "2026-02")
	base := "/api/leases/" + store.FormatUUID(l.ID) + "/statement"

	resp, body := c.do(http.MethodGet, base+"?from=2026-02-01&to=2026-02-28", nil, nil)
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("status %d content type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	var st statement
	if err := json.Unmarshal([]byte(body), &st); err != nil {
		t.Fatal(err)
	}
	if st.LeaseID != store.FormatUUID(l.ID) || st.From != "2026-02-01" || st.To != "2026-02-28" || st.Opening != 40000 || st.Closing != 140000 {
		t.Errorf("statement = %+v", st)
	}
	if len(st.Entries) != 1 {
		t.Fatalf("entries = %+v", st.Entries)
	}
	e := st.Entries[0]
	if e.ID != rent.ID || e.Running != 140000 || e.Period == nil || *e.Period != "2026-02" || !strings.HasSuffix(e.Created, "Z") {
		t.Errorf("entry = %+v", e)
	}

	resp, body = c.do(http.MethodGet, base+"?from=2026-02-10&to=2026-02-01", nil, http.Header{"X-Request-Id": {"test-request-1"}})
	env := decodeEnvelope(t, body)
	if resp.StatusCode != http.StatusBadRequest || env.Error.Code != "validation_failed" || env.Error.RequestID != "test-request-1" {
		t.Errorf("reversed range: status %d envelope %+v", resp.StatusCode, env)
	}
	if len(env.Error.Details.Fields) != 1 || env.Error.Details.Fields[0].Path != "to" {
		t.Errorf("validation fields = %+v", env.Error.Details.Fields)
	}

	resp, body = c.do(http.MethodGet, base+"?from=yesterday", nil, nil)
	env = decodeEnvelope(t, body)
	if resp.StatusCode != http.StatusBadRequest || len(env.Error.Details.Fields) != 1 || env.Error.Details.Fields[0].Path != "from" {
		t.Errorf("malformed date: status %d envelope %+v", resp.StatusCode, env)
	}

	resp, body = c.do(http.MethodGet, "/api/leases/"+newKey(t)+"/statement", nil, nil)
	if env := decodeEnvelope(t, body); resp.StatusCode != http.StatusNotFound || env.Error.Code != "lease_not_found" {
		t.Errorf("unknown lease: status %d envelope %+v", resp.StatusCode, env)
	}
	resp, body = c.do(http.MethodGet, "/api/leases/123/statement", nil, nil)
	if env := decodeEnvelope(t, body); resp.StatusCode != http.StatusNotFound || env.Error.Code != "not_found" {
		t.Errorf("malformed lease id: status %d envelope %+v", resp.StatusCode, env)
	}
}
