package web

import (
	"net/http"
	"net/url"

	"github.com/jackc/pgx/v5/pgtype"

	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

type propertyInput struct {
	Name    string
	Address string
}

func parseProperty(f *form) propertyInput {
	return propertyInput{
		Name:    f.text("name", true, 120),
		Address: f.text("address", true, 240),
	}
}

type unitInput struct {
	Label      string
	Bedrooms   int
	MarketRent money.Cents
}

func parseUnit(f *form) unitInput {
	in := unitInput{
		Label:    f.text("label", true, 40),
		Bedrooms: f.integer("bedrooms", 0, 20),
	}
	if c := f.amount("market_rent", true, false); c != nil {
		in.MarketRent = *c
	}
	return in
}

func (s *Server) listProperties(w http.ResponseWriter, r *http.Request) {
	s.renderProperties(w, r, http.StatusOK, s.newView(r, "Properties", nil))
}

func (s *Server) renderProperties(w http.ResponseWriter, r *http.Request, status int, v *view) {
	rows, err := s.q.ListProperties(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	v.Data = rows
	s.render(w, r, status, "properties.html", v)
}

func (s *Server) createProperty(w http.ResponseWriter, r *http.Request) {
	f, err := postForm(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	in := parseProperty(f)
	if f.err() != nil {
		v := s.newView(r, "Properties", nil)
		v.Form, v.Errors = f.values, f.errs.Map()
		s.renderProperties(w, r, http.StatusUnprocessableEntity, v)
		return
	}
	p, err := s.q.CreateProperty(r.Context(), db.CreatePropertyParams{Name: in.Name, Address: in.Address})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.flash(r, "Property created.")
	http.Redirect(w, r, "/properties/"+store.FormatUUID(p.ID), http.StatusSeeOther)
}

// propertyPage is the data of a property page. Failed names the form that
// failed validation: "property", "new-unit" or a unit id.
type propertyPage struct {
	Property db.Property
	Units    []db.Unit
	Failed   string
}

func propertyValues(p db.Property) url.Values {
	return url.Values{"name": {p.Name}, "address": {p.Address}}
}

func (s *Server) showProperty(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(r, "id")
	if !ok {
		s.fail(w, r, errNotFound)
		return
	}
	s.renderProperty(w, r, http.StatusOK, id, "", nil, nil)
}

// renderProperty shows a property page; when failed is set, the named form
// is re-filled from values and shows errs.
func (s *Server) renderProperty(w http.ResponseWriter, r *http.Request, status int, id pgtype.UUID, failed string, values url.Values, errs map[string]string) {
	p, err := s.q.GetProperty(r.Context(), id)
	if store.IsNotFound(err) {
		s.fail(w, r, errNotFound)
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	units, err := s.q.ListUnitsByProperty(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	v := s.newView(r, p.Name, propertyPage{Property: p, Units: units, Failed: failed})
	v.Form = propertyValues(p)
	if failed != "" {
		v.Form, v.Errors = values, errs
	}
	s.render(w, r, status, "property.html", v)
}

func (s *Server) updateProperty(w http.ResponseWriter, r *http.Request) {
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
	in := parseProperty(f)
	if f.err() != nil {
		s.renderProperty(w, r, http.StatusUnprocessableEntity, id, "property", f.values, f.errs.Map())
		return
	}
	_, err = s.q.UpdateProperty(r.Context(), db.UpdatePropertyParams{ID: id, Name: in.Name, Address: in.Address})
	if store.IsNotFound(err) {
		s.fail(w, r, errNotFound)
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.flash(r, "Property saved.")
	http.Redirect(w, r, "/properties/"+store.FormatUUID(id), http.StatusSeeOther)
}

func (s *Server) createUnit(w http.ResponseWriter, r *http.Request) {
	propertyID, ok := uuidParam(r, "id")
	if !ok {
		s.fail(w, r, errNotFound)
		return
	}
	f, err := postForm(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	in := parseUnit(f)
	if f.err() == nil {
		_, err = s.q.CreateUnit(r.Context(), db.CreateUnitParams{
			PropertyID:      propertyID,
			Label:           in.Label,
			Bedrooms:        int32(in.Bedrooms),
			MarketRentCents: int64(in.MarketRent),
		})
		switch {
		case store.IsUniqueViolation(err, "units_property_id_label_key"):
			f.fail("label", "is already used by another unit of this property")
		case store.IsForeignKeyViolation(err, "units_property_id_fkey"):
			s.fail(w, r, errNotFound)
			return
		case err != nil:
			s.fail(w, r, err)
			return
		}
	}
	if f.err() != nil {
		s.renderProperty(w, r, http.StatusUnprocessableEntity, propertyID, "new-unit", f.values, f.errs.Map())
		return
	}
	s.flash(r, "Unit added.")
	http.Redirect(w, r, "/properties/"+store.FormatUUID(propertyID), http.StatusSeeOther)
}

func (s *Server) updateUnit(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(r, "id")
	if !ok {
		s.fail(w, r, errNotFound)
		return
	}
	unit, err := s.q.GetUnit(r.Context(), id)
	if store.IsNotFound(err) {
		s.fail(w, r, errNotFound)
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
	in := parseUnit(f)
	if f.err() == nil {
		_, err = s.q.UpdateUnit(r.Context(), db.UpdateUnitParams{
			ID:              id,
			Label:           in.Label,
			Bedrooms:        int32(in.Bedrooms),
			MarketRentCents: int64(in.MarketRent),
		})
		switch {
		case store.IsUniqueViolation(err, "units_property_id_label_key"):
			f.fail("label", "is already used by another unit of this property")
		case err != nil:
			s.fail(w, r, err)
			return
		}
	}
	if f.err() != nil {
		s.renderProperty(w, r, http.StatusUnprocessableEntity, unit.PropertyID, store.FormatUUID(id), f.values, f.errs.Map())
		return
	}
	s.flash(r, "Unit "+in.Label+" saved.")
	http.Redirect(w, r, "/properties/"+store.FormatUUID(unit.PropertyID), http.StatusSeeOther)
}
