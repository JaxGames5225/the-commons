# The Commons

A shared, prompt-built website. Visitors describe what they want and an AI builder creates a working little web app or page for everyone to explore. No sign-in is required.

## Run locally

1. Install Node.js 20+ and PostgreSQL.
2. Create a PostgreSQL database and copy `.env.example` to `.env`. Add its connection URL, a long random session secret, and an OpenAI API key.
3. Run `npm install` and `npm start`.
4. Open `http://localhost:3000` and start adding to the Commons.

The app creates its tables and starter page on first launch. The homepage and all Commons pages are available without an account. New pages and additions are generated from prompts by the model in `OPENAI_MODEL` (defaults to `gpt-6-astra`).

## Deploy on Railway

1. Push this folder to a GitHub repository.
2. In Railway, create a project and deploy the repository as a service.
3. Add a PostgreSQL service to the same project. In the web service's **Variables** tab, add a reference variable named `DATABASE_URL` with a value like `${{Postgres.DATABASE_URL}}`. Replace `Postgres` with the exact name of your database service. Railway requires this reference; without it the app tries localhost and cannot connect.
4. Set `SESSION_SECRET`, `OPENAI_API_KEY`, and optionally `OPENAI_MODEL` in the web service variables. The model key is used only on the server; never put it in browser code.
5. Deploy. Railway uses `npm start`; `/health` is the health check.

The database holds shared pages, generated app code, contribution history, and reports. Keep the database private; only the web service needs its connection variable. Generated HTML and JavaScript run in sandboxed, network-restricted iframes and are saved as page fragments; each new prompt adds a fragment instead of executing code in the Commons server.

## Current behavior

The home page has one floating prompt. A prompt creates a new page, creates a subpage when requested from inside another page, or appends a generated mini-app to the current page. `/explore` lists top-level pages. Reports are recorded for moderators; a review dashboard and shared data storage inside individual mini-apps are future additions.
# the-commons
# the-commons
