# IS MU course parsing: first verified integration

Verified on 1 November 2026 against the authenticated registration/enrolment page supplied by the user. The original discovery probe has since become the `list_courses` MCP tool.

## What worked

An HTTP GET to `/auth/student/zapis` redirects to `https://muni.islogin.cz/login/...`. The login page provides a standard URL-encoded POST form with `akce=login`, `credential_0` (UČO/username), and `credential_1` (primary password). Submitting the observed form with an in-memory cookie jar returned the authenticated course page. This account's observed flow did not require browser JavaScript or an additional authentication step.

Course records are already present in the server-rendered HTML. The important structure is:

- `#app_content .registrace-predmetu-app` contains the application.
- `#rpa-predmety-pripraveno`, `#rpa-predmety-zaregistrovano`, and `#rpa-predmety-zapsano` distinguish prepared, registered, and enrolled courses.
- Each `.rpa-predmet` card carries `data-predmet-id`, `data-fakulta-id`, `data-stav`, and `data-ukonceni` attributes.
- `.nazev-predmet .jen-kod` provides the code and course-detail link; `.jen-nazev` provides the title; `.kr-aktualne` provides credits.

The live result contained nine enrolled courses across three faculties. Parsed enrolled credits matched the page's displayed total. Zero credits were preserved as zero. Course links preserve faculty and semester context. Some seminar information is also embedded in initially collapsed markup, but this first parser does not interpret it.

## Implementation

[`src/is/courses.ts`](../src/is/courses.ts) exports a pure HTML-to-records parser with inferred `Course` and `CoursesPage` types. It preserves source identity, study/period context, status, credits, completion type, and original links. It rejects login pages, missing sections, incomplete records, conflicting statuses, duplicate offerings, and unexpected course-link destinations.

[`src/is/session.ts`](../src/is/session.ts) performs the observed login with an in-memory cookie jar and logs in again when IS redirects to the login form. It never prints credentials or serializes the cookie jar. Redirects are bounded and limited to the two observed HTTPS origins. The optional `save_obd_pref` flag is removed before requesting the page. The only POST is to the login form; no enrolment controls are submitted.

## Limits and next step

This proves access and parsing for one account, semester, and observed page layout. It does not establish MFA support, persistent sessions, expired-session recovery, every possible enrolment state, or access to grades, deadlines, and teaching materials. Those require their own discovery. The course list is now exposed as an MCP tool; requesting `/auth/student/zapis` without query parameters returns the current study and period. The next useful step is to follow a selected course's detail link to locate grades, deadlines, and materials.

Validation: successful authenticated HTTP fetch and parsing of that response; TypeScript typecheck; focused parser tests using synthetic markup rather than saved student HTML.

## Exam registration

Verified on 1 November 2026. `/auth/student/prihl_na_zkousky` without query parameters shows the current study and period. The overview lists current registrations (`tr_odhl_<term>` / `tr_odhl2_<term>` row pairs), exam series with future terms (links carrying `predmet` and `serie`), and courses without future terms. Each series page has an `h2` title, the concurrent-registration limit, and one `table.data1` row per term. The status cell's class is `ok` (actionable), `stav1` (actionable after unregistering elsewhere), or `ko` (not actionable).

Registering and unregistering are plain GET links carrying `prihlasit=1` or `odhlasit=1`. The parser therefore rebuilds every URL from a whitelist of numeric IDs instead of following page links, and the session refuses any URL with those flags. [`src/is/exams.ts`](../src/is/exams.ts) implements this; it is exposed as the `list_exams` MCP tool. Past terms (`vse=1`) and the exam iCal export (`/auth/udalosti/zkousky_export_ical`) are not used yet.
