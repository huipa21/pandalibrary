# Prompts

One implementation prompt per plan task: `<task-id>-<slug>.md` (for example
`F2-db-migrations.md`). Prompts are written **just before** a task starts, so they can
reflect what earlier tasks actually built.

## Workflow

1. **Write:** ask an agent to "write the prompt for task <id>". It reads the plan entry,
   the architecture docs, the ADRs, `progress/README.md`, and the merged code of the task's
   dependencies, then fills in [_template.md](./_template.md).
2. **Review:** a human checks scope, owned paths and acceptance criteria. Set
   `Status: Ready`.
3. **Implement:** start a **new** agent session in the task's worktree and give it only
   "Implement docs/prompts/<file>". The prompt must be self-contained.
4. **Close:** the implementing session sets `Status: Done` in the prompt and updates
   `progress/README.md`.

Prompts are kept after completion as a record of what was asked.

The [sidebar/dashboard follow-up](../plans/sidebar-dashboard-plan.md) and the
[bookheap follow-up](../plans/bookheap-plan.md) are complete requested planning
batches, and the [Book View batch](../plans/book-view-plan.md) is drafted. Their
prompts are drafted together with
explicit contracts. Before launching a later wave, read the merged dependency
hand-offs and update its prompts if the contracts changed.

## Index

| Task | Prompt | Status |
|---|---|---|
| F1 | [F1-repo-scaffold.md](./F1-repo-scaffold.md) | Done |
| F2 | [F2-db-migrations.md](./F2-db-migrations.md) | Done |
| F3 | [F3-web-scaffold.md](./F3-web-scaffold.md) | Done |
| X1 | [X1-extraction-epub-covers.md](./X1-extraction-epub-covers.md) | Done |
| F4 | [F4-server-skeleton.md](./F4-server-skeleton.md) | Done |
| A1 | [A1-auth-vertical-slice.md](./A1-auth-vertical-slice.md) | Done |
| C1 | [C1-catalog-core.md](./C1-catalog-core.md) | Done |
| R1 | [R1-reading-sync-api.md](./R1-reading-sync-api.md) | Done |
| W1 | [W1-library-ui.md](./W1-library-ui.md) | Done |
| X2 | [X2-pdf-cbz-extractors.md](./X2-pdf-cbz-extractors.md) | Done |
| X3 | [X3-mobi-fb2-extractors.md](./X3-mobi-fb2-extractors.md) | Done |
| W2 | [W2-reader-ui.md](./W2-reader-ui.md) | Done |
| I1 | [I1-importer.md](./I1-importer.md) | Done |
| S1 | [S1-search.md](./S1-search.md) | Done |
| SH1 | [SH1-shelves.md](./SH1-shelves.md) | Done |
| W3 | [W3-offline-pwa.md](./W3-offline-pwa.md) | Done |
| K1 | [K1-koreader-sync.md](./K1-koreader-sync.md) | Done |
| M1 | [M1-metadata-providers.md](./M1-metadata-providers.md) | Done |
| J1 | [J1-maintenance-jobs.md](./J1-maintenance-jobs.md) | Done |
| ST1 | [ST1-stats-api.md](./ST1-stats-api.md) | Done |
| E1 | [E1-notes-export.md](./E1-notes-export.md) | Done |
| O1 | [O1-opds.md](./O1-opds.md) | Done |
| W4 | [W4-search-shelves-ui.md](./W4-search-shelves-ui.md) | Done |
| W7 | [W7-stats-notes-export-ui.md](./W7-stats-notes-export-ui.md) | Done |
| W5 | [W5-admin-ui.md](./W5-admin-ui.md) | Done |
| W6 | [W6-metadata-merge-ui.md](./W6-metadata-merge-ui.md) | Done |
| Q1 | [Q1-release-e2e.md](./Q1-release-e2e.md) | Done |
| UX1 | [UX1-sidebar-shell.md](./UX1-sidebar-shell.md) | Done |
| UX2 | [UX2-system-smart-shelves.md](./UX2-system-smart-shelves.md) | Done |
| UX3 | [UX3-shelf-navigation-ui.md](./UX3-shelf-navigation-ui.md) | Done |
| UX4 | [UX4-dashboard-feeds-api.md](./UX4-dashboard-feeds-api.md) | Done |
| UX5 | [UX5-configurable-dashboard.md](./UX5-configurable-dashboard.md) | Done |
| UX6 | [UX6-bookmarks.md](./UX6-bookmarks.md) | Done |
| UX7 | [UX7-admin-users-api.md](./UX7-admin-users-api.md) | Done |
| UX8 | [UX8-admin-users-ui.md](./UX8-admin-users-ui.md) | Done |
| UX9 | [UX9-build-version.md](./UX9-build-version.md) | Done |
| UX10 | [UX10-layout-integration.md](./UX10-layout-integration.md) | Done |
| BH1 | [BH1-bookheap-storage-api.md](./BH1-bookheap-storage-api.md) | Ready |
| BH2 | [BH2-bookheap-assign-api.md](./BH2-bookheap-assign-api.md) | Ready |
| BH3 | [BH3-upload-dialog.md](./BH3-upload-dialog.md) | Done |
| BH4 | [BH4-bookheap-page.md](./BH4-bookheap-page.md) | Done |
| BH5 | [BH5-bookheap-integration.md](./BH5-bookheap-integration.md) | Ready |
| BV1 | [BV1-catalog-detail-api.md](./BV1-catalog-detail-api.md) | Ready |
| BV2 | [BV2-reading-log-api.md](./BV2-reading-log-api.md) | Ready |
| BV3 | [BV3-cover-kit.md](./BV3-cover-kit.md) | Ready |
| BV4 | [BV4-details-shell.md](./BV4-details-shell.md) | Ready |
| BV5 | [BV5-quick-view.md](./BV5-quick-view.md) | Ready |
| BV6 | [BV6-details-tab.md](./BV6-details-tab.md) | Ready |
| BV7 | [BV7-files-tab.md](./BV7-files-tab.md) | Ready |
| BV8 | [BV8-reading-log-tab.md](./BV8-reading-log-tab.md) | Ready |
| BV9 | [BV9-highlights-tab.md](./BV9-highlights-tab.md) | Ready |
| BV10 | [BV10-integration.md](./BV10-integration.md) | Ready |
