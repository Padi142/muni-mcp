<img src="assets/icon.svg" width="64" height="64" alt="">

# muni-mcp

An MCP server that lets your AI assistant read your study information from [IS MU](https://is.muni.cz), the information system of Masaryk University.

Ask things like "What deadlines do I have this week?", "How many points do I have in PA191?", "What new lecture slides are there in PV157?" or "When is my next exam, and are there free spots on another term?" and the assistant answers from your actual IS data.

It only reads. It never registers you for anything or signs you off. The one thing that can change in IS is a file's unread status: downloading a study material may mark it as read, as opening it in your browser does.

## What it can do

- **`list_courses`**: your courses this semester: credits, grade, how each course ends (exam, colloquium, credit), teachers, weekly schedule, how many study materials you haven't read yet, and links.
- **`list_deadlines`**: what's due now and coming up: online tests opening and closing, homework submission deadlines, exam sign-off deadlines, exam dates, application periods. It also shows recent changes, like a teacher updating your points. Your regular classes can be included too.
- **`list_exams`**: your exam registrations and all upcoming exam terms: date, time, room, free spots, registration deadlines, the teacher's notes, and whether you can still sign up. You can ask about a single course, e.g. `PV157`.
- **`list_grades`**: your final grades and credits this semester.
- **`list_notebooks`**: the points and notes teachers record for you in each course's notebooks (poznámkové bloky), with the files you submitted for each entry.
- **`list_materials`**: how many study materials you haven't read yet in each course, interactive syllabi, and open homework folders.
- **`list_course_files`**: every file in one course's study materials, with its folder, type, size and upload time.
- **`download_file`**: saves one of those files to disk so the assistant can read it. Recorded lectures and links can't be downloaded; they are listed with their URL instead.
- **`list_online_tests`**: your online tests (odpovědníky) with when they open and close, their status, and your results.

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

Downloads go to `~/Downloads/muni-mcp`, mirroring IS's folders. Set `MUNI_DOWNLOAD_DIR` to use another location. Files over 100 MB are refused unless the assistant asks for a higher limit.

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
- `is/student.ts` reads the main student page; `is/courses.ts` and `is/deadlines.ts` build on it.
- `is/exams.ts` reads the exam registration pages.
- `is/grades.ts`, `is/notebooks.ts`, `is/materials.ts` and `is/online-tests.ts` read grades, notebooks, study materials, and online tests.
- `is/time.ts` converts IS dates to proper Prague times.

The `docs/` folder has background research on how IS MU works and on [vut-mcp](https://github.com/TheRamsay/vut-mcp), a similar project for Brno University of Technology.

This is an unofficial personal project, not affiliated with Masaryk University.
