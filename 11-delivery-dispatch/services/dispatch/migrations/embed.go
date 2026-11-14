// Package migrations embeds the dispatch service's goose migrations.
package migrations

import "embed"

// FS holds the SQL migration files.
//
//go:embed *.sql
var FS embed.FS
