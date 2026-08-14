/**
 * `@app/contract` — everything the API and the frontends share, independent of route
 * shape. Routes are not declared here: `apps/api` exports `AppType`, and clients use
 * `hc<AppType>()`, so route types flow across with no codegen.
 *
 * The rule for this package: **no I/O, no Node dependencies, no browser dependencies.**
 * Everything here has to run on both sides.
 */

export * from './errors'
export * from './rbac'
