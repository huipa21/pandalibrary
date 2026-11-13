// Package importer imports books into one owning library. Duplicate detection is
// library-scoped; identical content in different libraries has separate catalog
// records backed by shared immutable content-addressed blobs.
package importer
