package main

import (
	"flag"
	"fmt"
	"os"

	"pandalibrary/internal/buildinfo"
)

func main() {
	var stamp buildinfo.Stamp
	flag.StringVar(&stamp.Commit, "commit", "", "full Git commit object ID")
	flag.StringVar(&stamp.CommitDate, "date", "", "RFC3339 commit committer date")
	flag.StringVar(&stamp.Dirty, "dirty", "", "whether the checkout is dirty")
	flag.StringVar(&stamp.Release, "release", "", "optional release tag")
	flag.Parse()
	if flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "unexpected stamp validation arguments")
		os.Exit(1)
	}
	info, err := buildinfo.New(stamp)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(info.Display())
}
