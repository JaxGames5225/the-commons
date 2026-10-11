# The Commons

The Commons is one shared website edited by everyone through a floating prompt. The entire site is stored as one HTML document in one PostgreSQL row. Each request gives the model the current source and asks it to return the updated complete website, so people can change anything already there. Styling stays close to plain browser defaults unless a prompt asks for design or styling.

Requests to create subpages are implemented as sections and hash navigation inside that same document. Concurrent edits use a revision check and regenerate against the latest saved version so one submission does not silently erase another.

## Run locally

1. Install Node.js 20+ and PostgreSQL.
2. Create a PostgreSQL database and copy `.env.example` to `.env`. Add its connection URL and an OpenAI API key.
3. Run `npm install` and `npm start`.
4. Open `http://localhost:3000` and start editing the Commons.

The app creates its single site record on first launch. Existing Commons canvas and subpage content is folded into that record the first time the new version starts. New source is generated with the model in `OPENAI_MODEL` (defaults to `gpt-6-astra`).

## Deploy on Railway

1. Push this folder to a GitHub repository.
2. In Railway, create a project and deploy the repository as a service.
3. Add a PostgreSQL service to the same project. In the web service's **Variables** tab, add a reference variable named `DATABASE_URL` with a value like `${{Postgres.DATABASE_URL}}`. Replace `Postgres` with the exact name of your database service.
4. Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in the web service variables. The API key is only used on the server.
5. Deploy. Railway uses `npm start`; `/health` is the health check.

Generated websites run in a sandboxed iframe with network access disabled. The separate prompt bar remains available above the site.
