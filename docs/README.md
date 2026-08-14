# Documentation

Start with [`architecture.md`](architecture.md). Everything else assumes it.

## The map

| Document                                                                                           | Read it when                                                 |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`architecture.md`](architecture.md)                                                               | Before writing any code in this repository                   |
| [`conventions.md`](conventions.md)                                                                 | Before your first commit                                     |
| **Features** — what already exists                                                                 |                                                              |
| [`features/auth.md`](features/auth.md)                                                             | Touching sign-in, sessions, cookies or invitations           |
| [`features/rbac.md`](features/rbac.md)                                                             | Adding a permission, or wondering why a checkbox is disabled |
| [`features/users.md`](features/users.md)                                                           | Changing the user lifecycle                                  |
| [`features/audit-log.md`](features/audit-log.md)                                                   | Recording an action, or reading the trail                    |
| [`features/console-shell.md`](features/console-shell.md)                                           | Adding a page or a navigation item                           |
| [`features/code-quality.md`](features/code-quality.md)                                             | The gate rejected something and you want to know which part  |
| [`features/docker.md`](features/docker.md)                                                         | Adding a service, or packaging for production                |
| **Guides** — how to extend                                                                         |                                                              |
| [`guides/add-frontend-app.md`](guides/add-frontend-app.md)                                         | Adding a second Vue app (a storefront, a customer portal)    |
| [`guides/add-api-module.md`](guides/add-api-module.md)                                             | Adding an endpoint, a table or a permission                  |
| [`guides/add-multi-tenancy.md`](guides/add-multi-tenancy.md)                                       | One installation has to serve several organisations          |
| [`guides/rename-template.md`](guides/rename-template.md)                                           | This has just become your project rather than a template     |
| **Decisions** — why                                                                                |                                                              |
| [`decisions/ADR-0001-session-cookies-over-jwt.md`](decisions/ADR-0001-session-cookies-over-jwt.md) | Someone proposes JWTs                                        |
| [`decisions/ADR-0002-rpc-types-over-openapi.md`](decisions/ADR-0002-rpc-types-over-openapi.md)     | Someone proposes generating a client                         |
| [`decisions/ADR-0003-single-tenant-core.md`](decisions/ADR-0003-single-tenant-core.md)             | Someone asks where the `tenant_id` went                      |

## What goes where

Three kinds of document, and the difference between them is not stylistic:

- **`features/`** describe **what exists**. Present tense, anchored to real file paths, and every claim checkable by opening the file it names. A feature doc that describes an intention is a lie with a filename.
- **`guides/`** describe **how to extend**. Numbered steps, copy-pasteable, ending in a checklist and a troubleshooting section. Written for somebody who has not read the rest of the docs.
- **`decisions/`** describe **why**, in the past tense, and are **not updated** when the code changes. If a decision is reversed, write a new ADR that supersedes it — the record of what was once believed is the whole point.

## The register

Anyone adding to these documents should match what is already here:

- A one-or-two-sentence lead, then `##` sections. No table of contents; the file is not that long.
- Every claim anchored to a backticked path — `apps/api/src/middleware/rbac.ts` — so it can be checked.
- Tables for matrices (permissions, endpoints, ports). Prose for reasoning.
- Fenced blocks tagged `bash`, `ts`, `sql` or `text`.
- Blockquote callouts (`>`) for the thing that will otherwise cost somebody an afternoon.
- Feature docs close with an imperative `## Conventions` list — the rules to follow when working on that feature.
- English, and the same plain register as the code comments. Explain **why**, not what the next line does.
