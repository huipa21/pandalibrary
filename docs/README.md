# PandaLibrary docs

| Folder | Purpose |
|---|---|
| [architecture/](./architecture/) | Current design: [system](./architecture/system.md), [database](./architecture/database.md), [migrations](./architecture/migrations.md), [bookheap](./architecture/bookheap.md) |
| [decisions/](./decisions/README.md) | ADRs: why things are the way they are |
| [plans/](./plans/README.md) | Numbered steps: which tasks run in parallel and which run alone |
| [prompts/](./prompts/README.md) | One self-contained implementation prompt per task (written first, then implemented) |
| [progress/](./progress/README.md) | Task status board and dated log |

The database schema is **not** in the docs. It lives in
[internal/db/migrations](../internal/db/migrations/) and is applied automatically on startup
([ADR-0003](./decisions/0003-auto-applied-migrations.md)).

Agent sessions should start with: this file → `progress/README.md` → their prompt.

Current sidebar/dashboard integration hand-offs:
[bookmarks and offline sync](./prompts/UX6-bookmarks.md),
[account administration](./prompts/UX8-admin-users-ui.md), and
[integration/release verification](./prompts/UX10-layout-integration.md).
