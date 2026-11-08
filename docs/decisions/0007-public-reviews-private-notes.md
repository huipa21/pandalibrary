# ADR-0007: Public reviews are separate from private notes

- Status: Accepted
- Date: 2026-11-09

## Context

The Details page previously treated the viewer's latest book-level note as
a personal review. The reader also creates book-level notes, so publishing
that content as multi-user reviews would expose private annotations.

## Decision

Store one public plain-text review per user/book in `book_reviews`, with
visibility-scoped session API routes. Anyone who can see a book can read
its reviews. Authors may edit/delete their own; administrators may delete
others for moderation. Notes remain private and are never migrated.
Reviews are online-only and excluded from the private reading sync protocol.
Ratings are not exposed through reviews.

## Alternatives considered

- Publish existing book-level notes: rejected because they were authored
  privately and have no public-review consent.
- Add visibility flags to notes: rejected because it mixes annotation sync
  ownership with public pagination, authorship and moderation.

## Consequences

Existing annotations remain private without migration ambiguity. Public
reviews have their own validation, pagination and moderation contract.
Users write a new review explicitly; offline review editing and review
ratings remain outside this version's scope.
