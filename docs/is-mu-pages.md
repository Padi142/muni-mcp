# IS MU pages: what we read and how

Verified on 1 November 2026 against one student account. All pages are server-rendered HTML or JSON wrapping HTML; no browser JavaScript is needed. Parser tests use synthetic markup, never saved student pages.

## Login

A GET to any `/auth/...` page redirects to `https://muni.islogin.cz/login/...`. That page has a URL-encoded POST form with hidden fields, `credential_0` (UČO) and `credential_1` (primary password). Submitting it with an in-memory cookie jar returns to the requested page. This account needed no second factor.

[`src/is/session.ts`](../src/is/session.ts) implements this. It logs in lazily, logs in again whenever IS redirects to the login form, follows at most 12 redirects across the two known HTTPS origins, and never forwards credentials across origins. Cookies stay in memory.

GET requests retry twice on a dropped connection or HTTP 409/502/503/504, and at most four requests run at once per session.

IS changes state through plain GET links, so the session refuses any URL containing `prihlasit=`, `odhlasit=` (exam registration) or `operace=` (actions such as toggling a favourite course). The only POST it sends is the login form.

IS separates query parameters with `;`, which `URLSearchParams` does not parse, so the code builds and reads these URLs by hand.

## Student page (`/auth/student/`)

- **Study context:** the search form's hidden inputs `fakulta`, `obdobi` and `studium` hold the current faculty, period and study.
- **Courses:** `#tab-content-predmety-subcontent .predmet_conteiner` cards. The course ID is in `#predmet-button-<id>`, the faculty ID in the logo path `/loga/<faculty>.svg`, the code in `strong`, and `.isi-potvrzeni.ok` marks a completed course.
- **Course info panel:** loaded on expand from `/auth/student/index_ajax?fakulta;obdobi;studium;vsechna_studia=0;predmet_id;option=predmet-option-info`. It returns `{ html }` with teachers (`.vyucujici`), the schedule, grade, credits and completion type (`.hodnoceni span[title]`), and links to materials (with an unread count), forum and catalogue.
- **Events:** loaded from `index_ajax?obdobi;studium;option=udalosti-init`. Three panels: `.stud_udalosti-ted` (now), `.stud_udalosti-ceka` (upcoming), `.stud_udalosti-posledni` (recent changes). Recent changes use month headings ("Říjen 2026") with a day label per row ("Neděle 25. 10."). The other panels have `h3` day headings without a year, then category rows (`Zkoušky`, `Odpovědníky`, `Státnice`, `Rozvrh`…) containing a `.stud_udalosti-box` of rows. A `.stud_udalosti_header` row carries the title for the following `.stud_udalosti_content` row. Content rows hold times (`-od`, `-do`), and optional `-predmet`, `-osoba`, `-mistnost`, `-rozsah` (inclusive range), `-obdobi` and `-fakulta`.

[`src/is/courses.ts`](../src/is/courses.ts) and [`src/is/deadlines.ts`](../src/is/deadlines.ts) implement these as the `list_courses` and `list_deadlines` tools. The day headings' year is inferred from today's date in Prague.

## Exam registration (`/auth/student/prihl_na_zkousky`)

Without query parameters it shows the current study and period. The overview lists current registrations (`tr_odhl_<term>` / `tr_odhl2_<term>` row pairs), exam series with future terms (links carrying `predmet` and `serie`), and courses without future terms. Each series page has an `h2` title, the concurrent-registration limit, and one `table.data1` row per term. The status cell's class is `ok` (actionable), `stav1` (actionable after unregistering elsewhere), or `ko` (not actionable).

[`src/is/exams.ts`](../src/is/exams.ts) rebuilds every URL from a whitelist of numeric IDs instead of following page links, and exposes this as `list_exams`. Past terms (`vse=1`) and the exam iCal export (`/auth/udalosti/zkousky_export_ical`) are not used yet.

## Grades and notebooks

- **Grades** (`/auth/student/moje_znamky`): `table.data3 tr.elem_vybrane_obdobi` rows with seven cells: `FAC:CODE` and name, credits, completion type, grade (cell class `ok`/`ko` for passed/failed), date, note (e.g. "uznáno"), and who entered it. `.elem_vybrane_obdobi_only` holds "Kredity v zobrazeném semestru: N z M". The page's `prepocist_kredity=1` link triggers a recount and is never requested.
- **Notebooks** (`/auth/student/poznamkove_bloky_nahled`): one `li.ipb-seznam-pol` per course, one `.ipb-pol` per notebook with `.ipb-nazev`, raw content in `.ipb-obsah pre`, and `.ipb-zmeneno` (changed, by). By IS convention `*N` marks points and `@X` a final grade.

## Study materials

- **Overview** (`/auth/student/studijni_materialy`): `h2` sections, each followed by a list or a "none" note: interactive syllabi, unread-file counts per course, open submission folders (odevzdávárny) with "(do D. M. YYYY vč.)", and all courses with materials (folder in the link's `furl`).
- **Files** come from the documented File Manager API, `/auth/dok/fmgr_api?url=<folder>`, as XML. Each `uzel` lists its `poduzly/poduzel` subfolders, each with its own `objekty/objekt` files (`jmeno_souboru`, `mime_type`, `velikost`, `vlozeno` as local time, `vlozil_jmeno`, `cesta`). Numbered subfolders have no `nazev`. Objects with mime `my/url` are links whose target is the file name. Files download from `/auth<cesta>`. Many lecture PDFs have a `.txt` version.

## Online tests (`/auth/elearning/test_pruchod_el_student`)

One `.seznam-odp-predmet` block per course with `table.data3` rows: name and link (`td.uzel`), result (`td.hodn-pb`), status as the icon title in `td.budik`, and the window as `od`/`do` wrappers around `.odp_date_time`. Rows with class `odp_bez_prav` are not accessible. Courses with very many tests are listed in `.zdurazneni.upozorneni` instead; showing them needs `prepocitat_vsechno=1`, a recount over five minutes long, which is never requested. Test links only select a test and are never followed.

## Not covered yet

Second-factor login, IS reminders (`/auth/student/is_pripomina`, empty for this account, so its structure is unknown), downloading file contents, and grades from earlier semesters.
