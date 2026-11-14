// Package billing holds the pure rules for rent schedules, proration,
// allocation of payments, late fees and aging. It performs no I/O.
package billing

// Lease statuses.
const (
	LeaseDraft  = "draft"
	LeaseActive = "active"
	LeaseEnded  = "ended"
)

// Billable reports whether a lease in the given status accepts ledger
// entries and is processed by the billing jobs.
func Billable(status string) bool {
	return status == LeaseActive || status == LeaseEnded
}

// Kind is the kind of a ledger entry.
type Kind string

// Ledger entry kinds.
const (
	KindRent          Kind = "rent"
	KindLateFee       Kind = "late_fee"
	KindOtherCharge   Kind = "other_charge"
	KindDepositCharge Kind = "deposit_charge"
	KindPayment       Kind = "payment"
	KindCredit        Kind = "credit"
	KindReversal      Kind = "reversal"
)

// IsCharge reports whether entries of kind k increase what the tenant owes.
func (k Kind) IsCharge() bool {
	switch k {
	case KindRent, KindLateFee, KindOtherCharge, KindDepositCharge:
		return true
	}
	return false
}

// IsCredit reports whether entries of kind k reduce what the tenant owes.
func (k Kind) IsCredit() bool {
	return k == KindPayment || k == KindCredit
}

// Label returns a short human-readable name for k.
func (k Kind) Label() string {
	switch k {
	case KindRent:
		return "Rent"
	case KindLateFee:
		return "Late fee"
	case KindOtherCharge:
		return "Other charge"
	case KindDepositCharge:
		return "Deposit"
	case KindPayment:
		return "Payment"
	case KindCredit:
		return "Credit"
	case KindReversal:
		return "Reversal"
	}
	return string(k)
}
