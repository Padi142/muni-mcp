# How VUT MCP works, and what to carry over to MUNI

Research date: 1 November 2026. Source reviewed: [`TheRamsay/vut-mcp` at `d1d727f`](https://github.com/TheRamsay/vut-mcp/tree/d1d727fa1c61a659883a02ede66c0063ff11e084). This is a source-code review and public-documentation study; no university accounts were accessed and live authenticated behavior was not tested. MUNI recommendations below are proposals, not verified integrations.

## The main idea

VUT MCP is a personal university-data client with an MCP interface. It retrieves information from university systems, converts it into typed records, and applies ordinary programmatic rules to answer useful questions such as “What needs my attention?” An AI assistant calls those functions and explains their results. The university integration and planning logic live in the application; the MCP layer makes them available to the assistant. [Server implementation][server], [aggregation rules][aggregates]

For MUNI, the most useful thing to reproduce is this separation. TypeScript is a suitable implementation language. The substantial work will be discovering reliable access to the systems your courses actually use, handling their authentication, and interpreting their data consistently.

## 1. The main pieces

The repository contains three Python packages and optional user interfaces:

- **`vut_studis`** handles StudIS login, HTTP requests, HTML parsing, typed records, caching, course summaries, and change detection.
- **`vut_moodle`** integrates a second teaching system through Moodle REST functions or authenticated HTML pages.
- **`vut_mcp`** registers tools with FastMCP and delegates to those clients. It also composes a cross-source agenda.
- **A debug CLI** exposes library functionality directly, which makes authentication and parser problems inspectable without an AI conversation.
- **A Raycast extension** provides a conventional interface for daily actions, grades, and changes. [Package configuration][project], [server][server], [Moodle client][moodle-client], [CLI][cli]

The usual flow is: an assistant calls an MCP tool; the client reads cached data or requests a university page; a parser produces typed records; application code builds the requested view; the tool returns the result. The server entry point runs FastMCP as a process launched by the MCP host. The entry point does not configure a hosted HTTP service. [Server][server], [StudIS transport][transport], [cache implementation][cache]

There is no LLM provider integration in the reviewed application path. Its parsers and rules do the extraction and aggregation; the model belongs to the connected assistant. [Dependencies][project], [parsers][grades-parser], [aggregation rules][aggregates]

## 2. Where the data comes from

### StudIS: authenticated HTML

The StudIS connector reads the same web application a student uses. Its entry points include the electronic index, personal timetable, and course updates. It discovers course-detail links in the index and follows additional assignment or submission-detail links when needed. This is purpose-built navigation across known pages rather than a general website crawler. [Endpoint constants][constants], [client navigation][client]

Separate parsers handle grades, assessment components, exam/assessment terms, assignments, timetable entries, and update metadata. For example, the grades parser recognizes a table by Czech column labels and expects 13 cells per data row. It normalizes dates, numeric points, completion states, and academic-year information. This makes results much easier for tools to consume, but ties the integration to the university's page structure and language. [Grades parser][grades-parser], [assessment parser][assessment-parser]

Pydantic models describe records such as `Grade`, `CourseTerm`, `CourseAssignment`, and `PendingAction`. Many fields explicitly allow missing values. That distinction matters: an unknown submission state or score should not automatically become “not submitted” or zero. [Domain models][models]

### Moodle: a separate connector

Moodle has its own configuration and session cookie. Its access modes are:

- **`web`:** use authenticated Moodle pages.
- **`api`:** require a supplied token and use REST functions.
- **`auto`:** use REST when a token exists, with web fallback for handled Moodle API errors; otherwise use web access.

The REST adapter calls functions for site identity, enrolled courses, course contents, and assignments. It does not create a token automatically. Sharing VUT credentials for SSO does not mean sharing the StudIS session. [Moodle API adapter][moodle-api], [access-mode selection][moodle-client], [configuration][config]

Materials are generally exposed as links and metadata. A separate, explicit tool can extract bounded text from a supported assignment attachment, after checking that the exact URL belongs to that assignment. The implementation caps file size at 8 MiB and returned text at 50,000 characters; the documented PDF limit is 50 pages. It does not continuously download or index course materials. [Attachment implementation][moodle-client], [extraction implementation][extraction]

## 3. What the assistant can do

The reviewed server exposes **25 tools**, grouped around a few user needs:

- **Planning:** student summary, daily briefing, pending actions, and an agenda combining StudIS actions with Moodle assignment deadlines.
- **Course progress:** grades, points, course status, assessment components, and assessment-term dashboards.
- **Details:** timetable, terms, assignments, course updates, and explicitly requested teacher messages.
- **Materials:** Moodle courses, assignments, attachments, extracted attachment text, and course resources.
- **Memory and changes:** snapshot differences, notification payloads, personal course notes, and dismissed briefing items. [Registered tools][server]

Tool descriptions also guide the assistant toward economical calls. For example, course status defaults to a summary, with an explicit full mode for assessment, term, and assignment details. [Course-status implementation][client]

University access is read-only: these tools do not register for exams, submit assignments, or change enrollment. Notes and dismissed items write to the application's own local database. Change checks also update local snapshots, and notification delivery can be recorded locally. “Read-only” therefore describes its interaction with university records. [Tool handlers][server], [local storage][cache]

## 4. How raw records become useful answers

The useful assistant behavior is largely deterministic. Rules identify an available registration, an upcoming registered term, an unsubmitted assignment before its deadline, or points below a required minimum. They attach severity, a reason, and a suggested next step. These are recommendations to act, not execution of the academic action. [Pending-action rules][aggregates]

A daily briefing combines those actions with change notifications, sorts them, removes locally dismissed items, and includes personal notes. Its summary is constructed in code. [Briefing builder][briefing]

The cross-source agenda is a separate view. It converts dated StudIS actions and Moodle assignment deadlines into a common format, sorts and deduplicates items by generated identity, and returns at most 250 entries. That deduplication does not establish that two different systems refer to the same real-world assignment. The current agenda fetches both sources together; a failure in one can fail the combined request. [Agenda composition][agenda], [agenda tool][server]

For MUNI, this suggests building reliable records and explicit rules before adding natural-language polish. The assistant should receive facts, dates, source links, and uncertainty that it can explain.

## 5. Cache, history, and notifications

SQLite stores parsed cache entries, state snapshots, delivered-notification identifiers, dismissed briefing items, and course notes. StudIS data has a 30-minute cache lifetime; Moodle uses different lifetimes for different resources. Most data tools support a forced refresh. Cache keys include a source/account scope. [SQLite storage][cache], [StudIS lifetimes][constants], [Moodle lifetimes][moodle-client]

Change detection compares the current normalized records with the previous local snapshots. It reports additions, removals, and changed fields. The initial check establishes a baseline rather than announcing every existing record as new. A later check advances the stored state, so this is a view of changes since the previous check rather than a university event stream. [Change detection][changes]

Notification planning has a fast mode for course/grade changes and a deeper mode that includes pending actions. Delivered identifiers suppress duplicates. These checks run when requested; they should not be mistaken for continuous server-side university push notifications. The README marks macOS desktop banners experimental and identifies Raycast toasts as the supported notification interface. [Notification implementation][notifications], [project usage notes][readme]

The cache does not implement a general stale-data fallback when a live fetch fails. Most client methods return the cached value without exposing its cache metadata to the caller. For our version, freshness and source availability should be explicit so an assistant can distinguish “nothing is due” from “this source could not be checked.” [Cache fetch behavior][cache], [client return values][client]

## 6. What to preserve, and what to improve

The strongest choices are the reusable client library, thin MCP handlers, typed records, separate source connectors, explicit detail retrieval, and fixture-based parser tests. These let the same integration serve an assistant, CLI, or conventional interface. Raycast demonstrates this: its TypeScript code starts Python and consumes JSON directly instead of communicating through MCP. [Raycast bridge][raycast], [parser tests][parser-tests], [MCP payload tests][payload-tests]

The main limitations to account for are:

- **Page-layout dependence.** Changed table headings or cell counts can cause missed records. A parser returning an empty list must not automatically be treated as proof that no data exists. [Grades parser][grades-parser]
- **Authentication maintenance.** Login follows VUT-specific forms and redirects. The transport persists cookie rotation and refreshes an expired session once when credentials are available. That flow needs to be rediscovered for MUNI. [Login implementation][auth], [session transport][transport], [authentication tests][auth-tests]
- **Expensive aggregate reads.** Detailed planning can fetch several resources per course. Some bounded concurrency exists in the assessment dashboard, but broad pending-action retrieval loops through courses and can make many requests. [StudIS client][client]
- **Rules reflect source assumptions.** An early-semester score below a final minimum is not necessarily urgent. MUNI's grading conventions need their own interpretation rather than copied severity rules. [Assessment rules][aggregates]
- **Time handling needs attention.** The agenda treats legacy timezone-naive StudIS timestamps as UTC. For MUNI, local university times should be interpreted explicitly in `Europe/Prague`, then normalized with daylight-saving changes accounted for. [Agenda time conversion][agenda]

## 7. A TypeScript shape for `muni-mcp`

Start with one TypeScript package and clear internal modules; multiple publishable packages can wait. A useful division is source adapters, authentication/HTTP transport, pure parsers, shared domain records, a local store, and thin MCP/CLI entry points.

The proposed equivalents are:

- **Official MCP TypeScript server SDK** for tool registration and transport. The current v2 documentation uses `@modelcontextprotocol/server`, with Zod schemas validating tool inputs and inferring handler types. Start with stdio when the MCP host can launch the process; a remote endpoint is a separate deployment choice. [Official SDK guide](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server)
- **Zod schemas with inferred TypeScript types** at external-data boundaries, avoiding duplicate interfaces and unchecked casts.
- **HTTP requests with deliberate cookie/session handling**, followed by **Cheerio** for server-rendered HTML. Cheerio does not execute page JavaScript; browser automation would be needed only for flows that actually require it. [Cheerio documentation](https://cheerio.js.org/docs/intro/)
- **SQLite** for a personal cache, snapshots, and notes. This keeps the initial deployment close to the VUT design without introducing a separate backend service.

A course identity should include its source, faculty or source-native identifier where relevant, and semester/offering. Every normalized record should retain its original link and fetch time. Keep source-specific information when normalization would erase something meaningful. These are design recommendations for MUNI, not features already provided by VUT MCP.

The first milestone should prove one authenticated source end to end: retrieve enrolled courses and grades, validate them against the source page, and expose a small number of tools. Add timetable/deadline data next, then introduce a second source only when it covers a concrete gap in your own courses. Snapshot changes and daily briefings become useful once those records are dependable.

## 8. MUNI-specific discovery

Public MUNI documentation suggests three concrete directions:

- **Begin with IS MU.** It covers study administration, e-learning, and communication, so its own teaching tools deserve investigation alongside grades and enrolment. [Official IS MU overview](https://it.muni.cz/sluzby/informacni-system-mu)
- **Use documented exports where they fit.** IS MU supports external calendar subscriptions containing selected calendar layers, including timetable and exam events. Hidden layers are excluded; this does not establish coverage of every assignment deadline. [Calendar help](https://is.muni.cz/napoveda/komunikace/kalendar?zoomy_is=1)
- **Treat faculty platforms and APIs separately.** ELF is a Moodle-based Faculty of Arts service. IS MU's documented notebook API uses course/period keys configured through the Teacher area; it is not evidence of a general personal-student API. [ELF service](https://it.muni.cz/sluzby/phil/elektronicke-kurzy), [notebook API documentation](https://is.muni.cz/napoveda/technicka/bloky_api?lang=cs%2F%3Bzoomy_is%3D1)

See [MUNI integration notes](muni-integration-notes.md) for the companion study of official documentation, authentication constraints, and remaining access questions. Some IS help pages were available through search-indexed text rather than direct retrieval. Student access to private study records through a general API remains unverified.

The implementation decision to make first is **which source can reliably answer each personal study question**. The public university website is only the entry point; course records, teaching materials, and personal schedules may require different access paths. The VUT design gives us a good structure for those connectors, but its URLs, login forms, parsers, and grading rules are university-specific.

[project]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/pyproject.toml
[readme]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/README.md
[server]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_mcp/server.py
[client]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/client.py
[transport]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/transport.py
[auth]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/auth.py
[config]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/config.py
[constants]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/constants.py
[models]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/models.py
[grades-parser]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/parsers/grades.py
[assessment-parser]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/parsers/assessments.py
[aggregates]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/aggregates.py
[cache]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/cache.py
[changes]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/change_detection.py
[notifications]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/notifications.py
[briefing]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/assistant/briefing.py
[agenda]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_mcp/agenda.py
[moodle-client]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_moodle/client.py
[moodle-api]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_moodle/api.py
[extraction]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_moodle/extraction.py
[cli]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/src/vut_studis/cli.py
[raycast]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/raycast-extension/src/studis.ts
[parser-tests]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/tests/test_grades_parser.py
[payload-tests]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/tests/test_mcp_payloads.py
[auth-tests]: https://github.com/TheRamsay/vut-mcp/blob/d1d727fa1c61a659883a02ede66c0063ff11e084/tests/test_client_auth_retry.py
