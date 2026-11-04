package main

import (
	"encoding/json"
	"fmt"
	"os"

	"pandalibrary/internal/buildinfo"
)

func main() {
	info, err := buildinfo.Current()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(info); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
