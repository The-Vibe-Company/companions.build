# Production metrics

The web app uses PostHog project 313191 (TheCompanion). Set `VITE_POSTHOG_KEY`
to that project's public project key and `VITE_POSTHOG_HOST` to
`https://us.i.posthog.com` in the web build environment. Vite embeds these
settings at build time; rebuild and redeploy after changing them. The Docker
build accepts both names as build arguments. No private PostHog API key is used.
Without the public project key, analytics is disabled. Development does not send events.

Pageviews include initial loads and history navigation. Signed-in users are
identified by their persisted user ID, without email, name, chat contents or
session recordings. Sign-out resets analytics identity. Pageview URLs omit
query strings and fragments so magic-link and checkout credentials are excluded.

Set `STATS_TOKEN` on the API runtime to the shared metrics bearer credential.
`GET /api/stats` requires that credential in the Authorization Bearer header;
cookies do not grant metrics access. Missing configuration fails closed.
Responses are not cached. Other API routes retain their session authentication.

`total_users` counts Better Auth user records, not provider account links.
`new_users_1d` and `new_users_7d` use user creation timestamps. Activity uses
the latest persisted session sign-in/refresh or human message timestamp from
current discussions and legacy companion conversations. Counts deduplicate
users over rolling 24-hour and seven-day windows. Assistant/background messages
and user-profile updates do not count. Session refresh is daily, so passive
browsing between refreshes is not a precise last-seen measure; historical
activity cannot be recovered after session/message deletion. No new activity
ledger or migration is introduced.

After deployment, verify a pageview and signed-in identity in PostHog, and check
that the configured shared bearer receives the five numeric stats fields while
missing/wrong credentials receive 401. Never paste credentials into logs or PRs.
