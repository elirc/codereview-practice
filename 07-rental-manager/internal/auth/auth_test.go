package auth

import (
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestRolePermissions(t *testing.T) {
	tests := []struct {
		role Role
		perm Permission
		want bool
	}{
		{RoleViewer, PermView, true},
		{RoleViewer, PermEdit, false},
		{RoleViewer, PermReverse, false},
		{RoleViewer, PermRunJobs, false},
		{RoleViewer, PermManageUsers, false},
		{RoleManager, PermView, true},
		{RoleManager, PermEdit, true},
		{RoleManager, PermReverse, true},
		{RoleManager, PermRunJobs, false},
		{RoleManager, PermManageUsers, false},
		{RoleAdmin, PermView, true},
		{RoleAdmin, PermEdit, true},
		{RoleAdmin, PermReverse, true},
		{RoleAdmin, PermRunJobs, true},
		{RoleAdmin, PermManageUsers, true},
		{Role("owner"), PermView, false},
	}
	for _, tt := range tests {
		if got := tt.role.Can(tt.perm); got != tt.want {
			t.Errorf("%s.Can(%d) = %v, want %v", tt.role, tt.perm, got, tt.want)
		}
	}
}

func TestParseRole(t *testing.T) {
	for _, r := range Roles {
		if got, ok := ParseRole(string(r)); !ok || got != r {
			t.Errorf("ParseRole(%q) = %q, %v", r, got, ok)
		}
	}
	if _, ok := ParseRole("Admin"); ok {
		t.Error("ParseRole accepted a differently cased role")
	}
}

func TestHashPassword(t *testing.T) {
	hash, err := HashPassword("correct horse battery", bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte("correct horse battery")) != nil {
		t.Error("hash does not match its password")
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte("wrong")) == nil {
		t.Error("hash matches a different password")
	}
	if cost, err := bcrypt.Cost([]byte(hash)); err != nil || cost != bcrypt.MinCost {
		t.Errorf("cost = %d, %v", cost, err)
	}
}

func TestNormalizeEmail(t *testing.T) {
	if got := NormalizeEmail("  Admin@Example.COM "); got != "admin@example.com" {
		t.Errorf("NormalizeEmail = %q", got)
	}
}
