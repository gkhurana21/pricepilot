// Command engine is the subprocess entry point for the JSON bridge: it reads
// one request envelope from stdin, writes one response line to stdout, and
// exits 0 when the response is ok and 1 otherwise. Diagnostics go to stderr.
//
//	echo '{"op":"policy_hash","in":{}}' | go run ./cmd/engine
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/gkhurana21/pricepilot/bridge"
)

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("engine", flag.ContinueOnError)
	fs.SetOutput(stderr)
	version := fs.Bool("version", false, "print the module path and supported ops")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *version {
		fmt.Fprintf(stdout, "%s\nops: %s\n", bridge.ModulePath, strings.Join(bridge.OpNames(), ", "))
		return 0
	}

	in, err := io.ReadAll(stdin)
	if err != nil {
		fmt.Fprintln(stderr, "engine: reading stdin:", err)
		stdout.Write(append(bridge.ErrorResponse(err), '\n'))
		return 1
	}
	out, err := bridge.Handle(in)
	stdout.Write(append(out, '\n'))
	if err != nil {
		fmt.Fprintln(stderr, "engine:", err)
		return 1
	}
	return 0
}
