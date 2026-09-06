# Better Auth account implementation notes

Researched 6 September 2026 against Better Auth's official documentation. The implementation pins Better Auth 1.7.3, the current documented release at the time of research.

- Better Auth accepts a PostgreSQL `pg.Pool` directly. Its built-in Kysely adapter supports both schema generation and migration, and PostgreSQL joins can be enabled through `advanced.database.joins`. [PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql)
- Framework-neutral servers mount `auth.handler` on a catch-all `/api/auth/*` route. The server and browser communicate through standard `Request` and `Response` objects. [Installation](https://better-auth.com/docs/installation)
- The magic-link plugin exposes `POST /sign-in/magic-link`; its delivery callback receives the generated URL. A successful verification creates the session and redirects to the caller's callback URL. The link is single-use, and `storeToken: "hashed"` avoids storing the bearer token itself. [Magic link plugin](https://better-auth.com/docs/plugins/magic-link)
- Persistent authentication requires the `user`, `session`, `account`, and `verification` tables. The session token is a server-side session identifier carried by the browser cookie. [Database schema](https://better-auth.com/docs/concepts/database), [session management](https://better-auth.com/docs/concepts/session-management)

The repository keeps its SQL migration explicit in `apps/server/src/auth-schema.sql` so application and auth schema changes run in the existing advisory-locked migration transaction. Runtime schema validation is disabled because Better Auth initializes when the server module loads, before this repository's startup migration executes; the checked-in schema was generated from the pinned auth configuration with the official CLI.
