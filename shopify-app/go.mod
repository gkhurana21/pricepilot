// This file exists only so the Go tooling treats shopify-app/ as a separate,
// empty module. Without it, `go test ./...` and `gofmt -l .` at the repo root
// walk into node_modules, where some npm packages ship stray Go files.
module github.com/gkhurana21/pricepilot/shopify-app

go 1.26
