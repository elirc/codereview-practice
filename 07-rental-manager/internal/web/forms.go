package web

import (
	"errors"
	"net/http"
	"net/mail"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"rentalmanager/internal/apperr"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
)

// form reads typed values out of submitted fields, collecting a message
// per invalid field. Fields it is not asked about are ignored.
type form struct {
	values url.Values
	errs   apperr.ValidationError
}

// postForm parses an application/x-www-form-urlencoded body.
func postForm(r *http.Request) (*form, error) {
	if err := r.ParseForm(); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return nil, err
		}
		return nil, errMalformed
	}
	return &form{values: r.PostForm}, nil
}

// queryForm reads the URL query string.
func queryForm(r *http.Request) *form {
	return &form{values: r.URL.Query()}
}

func (f *form) err() error {
	return f.errs.Err()
}

func (f *form) fail(name, message string) {
	f.errs.Add(name, message)
}

func (f *form) raw(name string) string {
	return f.values.Get(name)
}

// text returns the trimmed value of name.
func (f *form) text(name string, required bool, maxLen int) string {
	v := strings.TrimSpace(f.values.Get(name))
	switch {
	case v == "" && required:
		f.fail(name, "is required")
	case utf8.RuneCountInString(v) > maxLen:
		f.fail(name, "must be at most "+strconv.Itoa(maxLen)+" characters")
	}
	return v
}

func (f *form) email(name string, required bool) string {
	v := f.text(name, required, 254)
	if v == "" || f.errs.Has(name) {
		return v
	}
	if addr, err := mail.ParseAddress(v); err != nil || addr.Address != v {
		f.fail(name, "must be an email address")
	}
	return v
}

func (f *form) date(name string, required bool) *calendar.Date {
	v := strings.TrimSpace(f.values.Get(name))
	if v == "" {
		if required {
			f.fail(name, "is required")
		}
		return nil
	}
	d, err := calendar.Parse(v)
	if err != nil {
		f.fail(name, err.Error())
		return nil
	}
	return &d
}

// amount parses a decimal amount into cents. positive rejects zero.
func (f *form) amount(name string, required, positive bool) *money.Cents {
	v := strings.TrimSpace(f.values.Get(name))
	if v == "" {
		if required {
			f.fail(name, "is required")
		}
		return nil
	}
	parse := money.Parse
	if positive {
		parse = money.ParsePositive
	}
	c, err := parse(v)
	if err != nil {
		f.fail(name, err.Error())
		return nil
	}
	return &c
}

func (f *form) integer(name string, lo, hi int) int {
	v := strings.TrimSpace(f.values.Get(name))
	if v == "" {
		f.fail(name, "is required")
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < lo || n > hi {
		f.fail(name, "must be a whole number from "+strconv.Itoa(lo)+" to "+strconv.Itoa(hi))
		return 0
	}
	return n
}

func (f *form) uuid(name string, required bool) pgtype.UUID {
	v := strings.TrimSpace(f.values.Get(name))
	if v == "" {
		if required {
			f.fail(name, "is required")
		}
		return pgtype.UUID{}
	}
	id, err := store.ParseUUID(v)
	if err != nil {
		f.fail(name, "is not a valid selection")
		return pgtype.UUID{}
	}
	return id
}

// uuids returns the distinct UUIDs submitted under name.
func (f *form) uuids(name string) []pgtype.UUID {
	var out []pgtype.UUID
	seen := make(map[pgtype.UUID]bool)
	for _, v := range f.values[name] {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		id, err := store.ParseUUID(v)
		if err != nil {
			f.fail(name, "contains an invalid selection")
			return nil
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func (f *form) choice(name string, options ...string) string {
	v := strings.TrimSpace(f.values.Get(name))
	for _, o := range options {
		if v == o {
			return v
		}
	}
	f.fail(name, "must be one of "+strings.Join(options, ", "))
	return ""
}

func (f *form) checked(name string) bool {
	switch f.values.Get(name) {
	case "on", "true", "1", "yes":
		return true
	}
	return false
}

// key returns an idempotency key submitted by a rendered form.
func (f *form) key(name string) string {
	id := f.uuid(name, true)
	if !id.Valid {
		return ""
	}
	return store.FormatUUID(id)
}

func uuidParam(r *http.Request, name string) (pgtype.UUID, bool) {
	id, err := store.ParseUUID(chi.URLParam(r, name))
	return id, err == nil
}

func int64Param(r *http.Request, name string) (int64, bool) {
	n, err := strconv.ParseInt(chi.URLParam(r, name), 10, 64)
	return n, err == nil && n > 0
}

func newFormKey() (string, error) {
	id, err := store.NewUUID()
	if err != nil {
		return "", err
	}
	return store.FormatUUID(id), nil
}
