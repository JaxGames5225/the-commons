# The Commons

A shared, login-gated community website. Members can create new pages and add contributions to pages everyone can see.

## Run locally

1. Install Node.js 20+ and PostgreSQL.
2. Create a PostgreSQL database and copy `.env.example` to `.env` with its connection URL and a long random session secret.
3. Run `npm install` and `npm start`.
4. Open `http://localhost:3000` and create the first member account.

The app creates its tables and starter page on first launch. The homepage and all Commons pages require an account. Registration is currently open to anyone who reaches the site.

## Deploy on Railway

1. Push this folder to a GitHub repository.
2. In Railway, create a project and deploy the repository as a service.
3. Add a PostgreSQL service to the same project. Railway exposes its `DATABASE_URL` to services when you add the variable reference.
4. Set `SESSION_SECRET` to a long random value in the web service variables.
5. Deploy. Railway uses `npm start`; `/health` is the health check.

The database holds accounts, shared pages, contribution history, and reports. Keep the database private; only the web service needs its connection variable.

## Current behavior

The prompt creates a community page from the request, or appends the request to an existing page. Pages are shared across members. Reports are recorded for moderators; a moderator review dashboard and richer AI-assisted page generation are natural next additions.
# the-commons
# the-commons
