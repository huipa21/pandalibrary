// Package catalog manages books with exactly one owning library. Changing a
// book's library moves that record and its files rather than adding membership;
// shared blob paths remain unchanged. Collections are independent logical groups.
package catalog
