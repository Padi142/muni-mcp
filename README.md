<img src="assets/icon.svg" width="64" height="64" alt="">

# muni-mcp

An MCP server that lets your AI assistant read your study information from [IS MU](https://is.muni.cz), the information system of Masaryk University.

Ask things like "What courses am I enrolled in?" or "When is my next exam, and are there free spots on another term?" and the assistant answers from your actual IS data.

It only reads. It never registers you for anything, signs you off, or changes your data in IS.

## What it can do

- **`list_courses`**: your courses for the current semester, with credits, how each course ends (exam, colloquium, credit), and links to the course pages.
- **`list_exams`**: your exam registrations and all upcoming exam terms: date, time, room, free spots, registration deadlines, the teacher's notes, and whether you can still sign up. You can ask about a single course, e.g. `PV157`.

## Setup

You need Node.js 22.19 or newer and pnpm.

```sh
git clone https://github.com/Padi142/muni-mcp.git
cd muni-mcp
pnpm install
```

The server logs in to IS MU with your UČO and primary password. Put each one in its own private file:

```sh
mkdir -p ~/.config/muni-mcp
printf '%s' '123456' > ~/.config/muni-mcp/uco
printf '%s' 'your-password' > ~/.config/muni-mcp/password
chmod 600 ~/.config/muni-mcp/*
```

Then add the server to your MCP client (Claude Desktop, Claude Code, Cursor, and others):

```json
{
  "mcpServers": {
    "muni": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/path/to/muni-mcp", "start"],
      "env": {
        "MUNI_USERNAME_FILE": "/home/you/.config/muni-mcp/uco",
        "MUNI_PASSWORD_FILE": "/home/you/.config/muni-mcp/password"
      }
    }
  }
}
```

If you prefer, you can set `MUNI_USERNAME` and `MUNI_PASSWORD` directly instead of using files.

## How it works

The server logs in to IS MU the same way your browser does, opens the relevant pages, and turns them into clean structured data for the assistant. Your login cookies are kept in memory only. When the session expires, it simply logs in again.

Because it reads web pages, a change to IS MU's page layout can break it. When that happens, it reports an error instead of guessing.

Accounts that require two-factor login are not supported yet.

## Development

```sh
pnpm typecheck
pnpm test
```

The code lives in `src/`:

- `server.ts` defines the MCP tools.
- `is/session.ts` handles logging in and fetching pages.
- `is/courses.ts` and `is/exams.ts` read the course and exam pages.
- `is/time.ts` converts IS dates to proper Prague times.

The `docs/` folder has background research on how IS MU works and on [vut-mcp](https://github.com/TheRamsay/vut-mcp), a similar project for Brno University of Technology.

This is an unofficial personal project, not affiliated with Masaryk University.
