# First-run administrator setup plan

1. Replace generated-credential API coverage with first-run setup and authenticated-session coverage.
2. Remove administrator bootstrap work from the service installer.
3. Make `/api/auth/setup` create a non-temporary administrator and session atomically from the browser request.
4. Make the login dialog show only fields relevant to setup, login, or password change.
5. Bump the PWA shell cache and validate installer, API, frontend, and full regression tests.
6. Back up both node databases, deploy, remove the temporary recovery credential files, and clear only users/sessions/login attempts so both nodes enter setup mode.
