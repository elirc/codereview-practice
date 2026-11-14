// Package auth holds users, roles and permissions.
package auth

import "github.com/jackc/pgx/v5/pgtype"

// Role is a user's role.
type Role string

// Roles, from least to most privileged.
const (
	RoleViewer  Role = "viewer"
	RoleManager Role = "manager"
	RoleAdmin   Role = "admin"
)

// Roles lists every role in display order.
var Roles = []Role{RoleViewer, RoleManager, RoleAdmin}

// ParseRole returns the role named s.
func ParseRole(s string) (Role, bool) {
	for _, r := range Roles {
		if string(r) == s {
			return r, true
		}
	}
	return "", false
}

// Permission is an action guarded by role.
type Permission int

// Permissions.
const (
	PermView Permission = iota + 1
	PermEdit
	PermReverse
	PermRunJobs
	PermManageUsers
)

// Can reports whether role r grants p.
func (r Role) Can(p Permission) bool {
	switch p {
	case PermView:
		return r == RoleViewer || r == RoleManager || r == RoleAdmin
	case PermEdit, PermReverse:
		return r == RoleManager || r == RoleAdmin
	case PermRunJobs, PermManageUsers:
		return r == RoleAdmin
	}
	return false
}

// Actor is the authenticated user on whose behalf work is done.
type Actor struct {
	UserID pgtype.UUID
	Role   Role
}
