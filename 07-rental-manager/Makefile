GO ?= go
HTMX_VERSION := 2.0.4
STATICCHECK_VERSION := 2024.1.1
SQLC_VERSION := v1.27.0

-include .env
export

.PHONY: build serve worker migrate seed test test-unit lint fmt sqlc htmx db-up db-down

build:
	$(GO) build -o bin/rentmgr ./cmd/rentmgr

serve:
	$(GO) run ./cmd/rentmgr serve

worker:
	$(GO) run ./cmd/rentmgr worker

migrate:
	$(GO) run ./cmd/rentmgr migrate up

seed:
	$(GO) run ./cmd/rentmgr seed

# Integration tests share one database, so packages run one at a time.
test:
	$(GO) test -p 1 -count=1 ./...

test-unit:
	TEST_DATABASE_URL= $(GO) test ./...

lint:
	test -z "$$(gofmt -l .)"
	$(GO) vet ./...
	$(GO) run honnef.co/go/tools/cmd/staticcheck@$(STATICCHECK_VERSION) ./...

fmt:
	gofmt -w .

sqlc:
	$(GO) run github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION) generate

htmx:
	mkdir -p internal/web/static/vendor
	curl -fsSL -o internal/web/static/vendor/htmx.min.js https://unpkg.com/htmx.org@$(HTMX_VERSION)/dist/htmx.min.js

db-up:
	docker compose up -d postgres

db-down:
	docker compose down
