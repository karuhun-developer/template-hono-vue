# ADR-0003 — A single-tenant core

- **Status:** accepted
- **Date:** 2026-08-15
- **Affects:** every table in `apps/api/src/db/schema/`, `apps/api/src/modules/rbac/`, `docs/guides/add-multi-tenancy.md`

## Context

This template was extracted from a working multi-tenant application. That application had a `tenant_id` on every table, a query-builder wrapper that injected the filter structurally, an ESLint fence around the bypass, and RBAC scoped per tenant **and** per branch. All of it worked and all of it was carried in from day one.

So the question was not "can we do multi-tenancy" — the code existed and was proven. It was **which default costs less when it is wrong.**

A template is wrong for most of its users in at least one dimension. What matters is the cost of correcting it.

**Ship multi-tenant, and single-tenant projects pay forever.** Every query carries a tenant that is always the same value. Every fixture creates a tenant first. `AccessContext` is a map keyed by something with one key. The relational query API is unavailable because it cannot be scoped safely. New developers ask what a tenant is and are told "there is only one". Removing it later means touching every table, every repository, every test and the whole RBAC layer — and doing it under the anxiety of "did I miss a filter", which is the same anxiety as adding it, without the payoff.

**Ship single-tenant, and multi-tenant projects pay once, up front, on a path somebody has already walked.**

The asymmetry is not close. Adding tenancy is a mechanical migration: add a column, add a filter, scope the uniqueness rules, split RBAC in two. Removing it is a rewrite of the same surface area with no mechanical rule to follow.

There is a second asymmetry that matters more. **A single-tenant application that grows a `tenant_id` has one new failure mode: a query that forgets its filter.** A multi-tenant application that is only ever used by one tenant has the same failure mode the whole time, permanently untested, until the day a second tenant arrives and it turns out that three queries never filtered anything.

## Decision

The core is **single-tenant**. One installation, one organisation.

- No `tenants` table, no `tenant_id` column, no branches, no `platform_admins`.
- `AccessContext` is a flat `ReadonlySet<PermissionKey>`. `can()` is a set membership test.
- Repositories take a `DatabaseHandle` and query directly. There is no scoping wrapper to bypass, and therefore no ESLint fence to explain.

And — this is the half that makes the decision defensible — **the migration path ships as a first-class document.** [`../guides/add-multi-tenancy.md`](../guides/add-multi-tenancy.md) contains the complete, working source of `tenant-db.ts` and `tenant-scope.ts` inline: the structural query scoping, the fail-closed `1 = 0` default for unrecognised tables, the JOIN handling that filters in `ON` rather than `WHERE`, the INSERT stamping, the ESLint fence over both doors, the two-dimensional RBAC, and the cross-tenant leak tests.

The code is not omitted. It is relocated to where it costs nothing until it is needed.

## Consequences

**The template is smaller in the way that matters.** Every layer can be read end to end without holding a tenancy invariant in your head, which is what makes the feature docs short enough to be read.

**Nothing is scoped, so nothing pretends to be.** There is no half-safe helper that filters by tenant in most places. A reader of any repository function sees exactly what it queries.

**The relational query API is available.** `db.query.users.findMany({ with: … })` is legal here. Under tenant scoping it is not, because nested subqueries cannot be given an outside predicate with the same guarantee.

**A project that needs tenancy does the work in one deliberate pass**, at a point where it knows its own uniqueness rules — which is the part of the migration that cannot be mechanical. "Is `lower(email)` unique globally or per tenant?" is a product question, and the answer is much better after the product exists.

**The relocated code is not compiled or tested.** It is documentation, so it can rot. Mitigation: it is one document, it names the version it was extracted from, and its Drizzle-specific parts are annotated with _why_ they are written that way — an author adapting it to a newer Drizzle has the reasoning, not just the source.

**A team that knew from the start it was building a multi-tenant SaaS pays a real cost:** a day of migration on top of a template that could have handed it to them. That is the trade, taken deliberately, because the majority of projects starting from a template are not that team — and the ones that are get a guide rather than nothing.

## What would change this

**A second template, not a change to this one.** If multi-tenant starts dominating, the answer is `template-hono-vue-saas` sharing the same conventions, not a flag on this repository. A template with a "multi-tenant: yes/no" switch is two templates in a trench coat, and both halves get tested half as much.

**The guide going stale would change something smaller:** either extract it into a `packages/tenancy` workspace that is compiled and tested but not wired in, or delete it and say plainly that tenancy is out of scope. A recipe that no longer works is worse than no recipe, because it is trusted.

This ADR is **not** superseded by a consuming project adding tenancy. That is the documented path, not a reversal. It would be superseded only if the template itself started shipping a `tenants` table.
