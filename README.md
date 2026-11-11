# minimi-chat-agent

A chat agent with one tool, web search, and a memory of every conversation it has had.

It is built to answer questions like:

- "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?"
- "What did I ask you on 3 November? Is your answer still correct today?"

> Work in progress. The server runs and serves a placeholder page; the agent is
> being built. See [docs/architecture.md](docs/architecture.md) for the design.

## Setup

Prerequisites: Node.js 22.13+ or 24+ (Node 24 recommended) and npm.

```sh
cp .env.example .env    # then fill in GEMINI_API_KEY and TAVILY_API_KEY
npm install
npm run dev
```

Open http://localhost:3000. Both API keys are free tier; `.env.example` says
where to get each one and lists the optional settings.

## Scripts

| Script                 | What it does                                 |
| ---------------------- | -------------------------------------------- |
| `npm run dev`          | Start the server and restart on file changes |
| `npm start`            | Start the server once                        |
| `npm test`             | Run the tests                                |
| `npm run typecheck`    | Type-check with `tsc`                        |
| `npm run lint`         | Lint with ESLint                             |
| `npm run format`       | Format with Prettier                         |
| `npm run format:check` | Check formatting without writing             |
| `npm run try:search`   | Run one live search and print its result     |
