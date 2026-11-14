package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"rentalmanager/internal/apperr"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

// BcryptCost is the bcrypt work factor for stored passwords.
const BcryptCost = 12

// Password length limits; bcrypt ignores input beyond 72 bytes.
const (
	MinPasswordLength = 10
	MaxPasswordLength = 72
)

// Errors returned by the user service.
var (
	ErrInvalidCredentials = errors.New("invalid email or password")
	ErrUserNotFound       = apperr.NotFound("user_not_found", "User not found.")
	ErrEmailTaken         = apperr.Conflict("email_taken", "A user with that email already exists.")
	ErrForbidden          = apperr.Forbidden("forbidden", "You do not have permission to do that.")
	ErrChangeOwnAccess    = apperr.Rule("cannot_change_own_access", "You cannot change your own role or deactivate your own account.")
)

// User is an account that can sign in. The password hash never leaves
// this package.
type User struct {
	ID     pgtype.UUID
	Email  string
	Name   string
	Role   Role
	Active bool
}

func toUser(u db.User) User {
	return User{ID: u.ID, Email: u.Email, Name: u.Name, Role: Role(u.Role), Active: u.Active}
}

// Actor returns u as the actor of an operation.
func (u User) Actor() Actor {
	return Actor{UserID: u.ID, Role: u.Role}
}

// NormalizeEmail returns the canonical stored form of an email address.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// HashPassword hashes a password with bcrypt at the given cost.
func HashPassword(password string, cost int) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(password), cost)
	if err != nil {
		return "", fmt.Errorf("hashing password: %w", err)
	}
	return string(h), nil
}

// Service manages users and authenticates them.
type Service struct {
	q         *db.Queries
	cost      int
	dummyHash []byte
}

// NewService returns a user service hashing passwords at cost.
func NewService(pool *pgxpool.Pool, cost int) (*Service, error) {
	dummy, err := bcrypt.GenerateFromPassword([]byte("timing-equaliser"), cost)
	if err != nil {
		return nil, fmt.Errorf("preparing password hasher: %w", err)
	}
	return &Service{q: db.New(pool), cost: cost, dummyHash: dummy}, nil
}

// Authenticate returns the active user with the given credentials.
func (s *Service) Authenticate(ctx context.Context, email, password string) (User, error) {
	u, err := s.q.GetUserByEmail(ctx, NormalizeEmail(email))
	if err != nil && !store.IsNotFound(err) {
		return User{}, fmt.Errorf("loading user: %w", err)
	}
	if err != nil || !u.Active {
		// Dummy compare so unknown emails take as long as known ones; the
		// result is deliberately discarded.
		_ = bcrypt.CompareHashAndPassword(s.dummyHash, []byte(password))
		return User{}, ErrInvalidCredentials
	}
	if err := bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)); err != nil {
		return User{}, ErrInvalidCredentials
	}
	return toUser(u), nil
}

// Get returns the user with id.
func (s *Service) Get(ctx context.Context, id pgtype.UUID) (User, error) {
	u, err := s.q.GetUser(ctx, id)
	if store.IsNotFound(err) {
		return User{}, ErrUserNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("loading user: %w", err)
	}
	return toUser(u), nil
}

// List returns every user ordered by email.
func (s *Service) List(ctx context.Context) ([]User, error) {
	rows, err := s.q.ListUsers(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing users: %w", err)
	}
	users := make([]User, len(rows))
	for i, r := range rows {
		users[i] = toUser(r)
	}
	return users, nil
}

// NewUser is a validated request to create a user.
type NewUser struct {
	Email    string
	Name     string
	Role     Role
	Password string
}

// Create adds a user.
func (s *Service) Create(ctx context.Context, actor Actor, in NewUser) (User, error) {
	if !actor.Role.Can(PermManageUsers) {
		return User{}, ErrForbidden
	}
	hash, err := HashPassword(in.Password, s.cost)
	if err != nil {
		return User{}, err
	}
	u, err := s.q.CreateUser(ctx, db.CreateUserParams{
		Email:        NormalizeEmail(in.Email),
		PasswordHash: hash,
		Name:         in.Name,
		Role:         string(in.Role),
	})
	if store.IsUniqueViolation(err, "users_email_key") {
		return User{}, ErrEmailTaken
	}
	if err != nil {
		return User{}, fmt.Errorf("creating user: %w", err)
	}
	return toUser(u), nil
}

// UserUpdate is a validated change to a user. An empty Password keeps the
// current password.
type UserUpdate struct {
	Name     string
	Role     Role
	Active   bool
	Password string
}

// Update changes a user's name, role, status and optionally password.
func (s *Service) Update(ctx context.Context, actor Actor, id pgtype.UUID, in UserUpdate) (User, error) {
	if !actor.Role.Can(PermManageUsers) {
		return User{}, ErrForbidden
	}
	if id == actor.UserID && (in.Role != actor.Role || !in.Active) {
		return User{}, ErrChangeOwnAccess
	}
	u, err := s.q.UpdateUser(ctx, db.UpdateUserParams{ID: id, Name: in.Name, Role: string(in.Role), Active: in.Active})
	if store.IsNotFound(err) {
		return User{}, ErrUserNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("updating user: %w", err)
	}
	if in.Password != "" {
		hash, err := HashPassword(in.Password, s.cost)
		if err != nil {
			return User{}, err
		}
		if err := s.q.UpdateUserPassword(ctx, db.UpdateUserPasswordParams{ID: id, PasswordHash: hash}); err != nil {
			return User{}, fmt.Errorf("updating password: %w", err)
		}
	}
	return toUser(u), nil
}
