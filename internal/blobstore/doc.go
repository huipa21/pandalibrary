// Package blobstore manages shared immutable content-addressed files and covers.
// Library ownership belongs to catalog book records, not blob paths. Moving or
// deleting a book must not relocate or eagerly remove potentially shared blobs.
package blobstore
