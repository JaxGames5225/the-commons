# The Commons

A shared prompt-built website: a blank canvas and one floating prompt. Visitors describe what to add; the generated HTML is saved in PostgreSQL and rendered on the canvas. No sign-in is required.

## Run locally

1. Install Node.js 20+ and PostgreSQL.
2. Create a PostgreSQL database and copy `.env.example` to `.env`. Add its connection URL and an OpenAI API key.
3. Run `npm install` and `npm start`.
4. Open `http://localhost:3000` and start adding to the Commons.

The app creates its tables and blank canvas on first launch. New HTML is generated from prompts by the model in `OPENAI_MODEL` (defaults to `gpt-6-astra`).

## Deploy on Railway

1. Push this folder to a GitHub repository.
2. In Railway, create a project and deploy the repository as a service.
3. Add a PostgreSQL service to the same project. In the web service's **Variables** tab, add a reference variable named `DATABASE_URL` with a value like `${{Postgres.DATABASE_URL}}`. Replace `Postgres` with the exact name of your database service. Railway requires this reference; without it the app tries localhost and cannot connect.
4. Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in the web service variables. The model key is used only on the server; never put it in browser code.
5. Deploy. Railway uses `npm start`; `/health` is the health check.

The database holds the canvas HTML, page HTML, and subpage relationships. Keep the database private; only the web service needs its connection variable. Saved HTML and JavaScript run in sandboxed, network-restricted iframes, never in the Commons server.

## Current behavior

The visible interface has exactly two parts: the HTML canvas loaded from the database and the floating prompt. Prompts append generated HTML to the current canvas; asking for a subpage creates a child page and adds its link to the parent canvas.
# the-commons
# the-commons
