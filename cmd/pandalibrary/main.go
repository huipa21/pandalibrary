package main

import (
	"errors"
	"fmt"
	"os"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	command := "serve"
	if len(args) > 0 {
		command = args[0]
	}

	switch command {
	case "serve", "migrate", "healthcheck":
		return fmt.Errorf("pandalibrary: %s is not implemented", command)
	case "user":
		if len(args) < 2 {
			return errors.New("pandalibrary: user requires a subcommand (create or reset-password)")
		}
		switch args[1] {
		case "create", "reset-password":
			return fmt.Errorf("pandalibrary: user %s is not implemented", args[1])
		default:
			return fmt.Errorf("pandalibrary: unknown user command %q", args[1])
		}
	default:
		return fmt.Errorf("pandalibrary: unknown command %q", command)
	}
}
