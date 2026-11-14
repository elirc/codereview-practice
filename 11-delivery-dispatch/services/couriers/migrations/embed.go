// Package migrations embeds the couriers service's goose migrations.
package migrations

import "embed"

// FS holds the SQL migration files.
//
//go:embed *.sql
var FS embed.FS
