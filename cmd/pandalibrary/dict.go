package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"pandalibrary/internal/dictionary"
	"pandalibrary/internal/dictionary/dictimport"
)

func dictUsage() string {
	ids := make([]string, len(dictionary.Sources))
	for index, spec := range dictionary.Sources {
		ids[index] = spec.ID
	}
	return "usage: pandalibrary dict import --source <" + strings.Join(ids, "|") + "> --file <path[.gz]> [--data-dir <directory>]\n" +
		"       pandalibrary dict list [--data-dir <directory>]"
}

func runDict(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New(dictUsage())
	}
	switch args[0] {
	case "import":
		return runDictImport(args[1:], stdout, stderr)
	case "list":
		return runDictList(args[1:], stdout, stderr)
	default:
		return errors.New(dictUsage())
	}
}

func runDictImport(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("dict import", flag.ContinueOnError)
	flags.SetOutput(stderr)
	source := flags.String("source", "", "dictionary source ID")
	filename := flags.String("file", "", "dictionary source file (optionally gzip-compressed)")
	dataDir := flags.String("data-dir", filepath.Dir(databasePath()), "data directory")
	if err := flags.Parse(args); errors.Is(err, flag.ErrHelp) {
		return nil
	} else if err != nil {
		return err
	}
	if *source == "" || *filename == "" || *dataDir == "" || flags.NArg() != 0 {
		return errors.New(dictUsage())
	}
	if _, _, ok := dictionary.SourceByID(*source); !ok {
		return fmt.Errorf("unknown dictionary source %q\n%s", *source, dictUsage())
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	path := dictionary.DefaultPath(*dataDir)
	started := time.Now()
	count, err := dictimport.ImportFile(ctx, path, *source, *filename, stderr)
	if err != nil {
		return fmt.Errorf("import %s: %w", *source, err)
	}
	_, err = fmt.Fprintf(stdout, "Imported %d %s entries into %s in %s.\n", count, *source, path, time.Since(started).Round(time.Millisecond))
	return err
}

func runDictList(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("dict list", flag.ContinueOnError)
	flags.SetOutput(stderr)
	dataDir := flags.String("data-dir", filepath.Dir(databasePath()), "data directory")
	if err := flags.Parse(args); errors.Is(err, flag.ErrHelp) {
		return nil
	} else if err != nil {
		return err
	}
	if *dataDir == "" || flags.NArg() != 0 {
		return errors.New(dictUsage())
	}
	sources, err := dictimport.List(context.Background(), dictionary.DefaultPath(*dataDir))
	if err != nil {
		return err
	}
	if len(sources) == 0 {
		_, err := fmt.Fprintln(stdout, "No dictionaries imported.")
		return err
	}
	table := tabwriter.NewWriter(stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(table, "SOURCE\tNAME\tENTRIES\tIMPORTED\tLICENSE")
	for _, source := range sources {
		fmt.Fprintf(table, "%s\t%s\t%d\t%s\t%s\n", source.ID, source.Name, source.Entries,
			time.UnixMilli(source.ImportedAt).UTC().Format(time.RFC3339), source.License)
	}
	return table.Flush()
}
