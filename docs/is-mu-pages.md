# IS MU pages: what we read and how

Verified on 1 November 2026 against one student account. All pages are server-rendered HTML or JSON wrapping HTML; no browser JavaScript is needed. Parser tests use synthetic markup, never saved student pages.

## Login

A GET to any `/auth/...` page redirects to `https://muni.islogin.cz/login/...`. That page has a URL-encoded POST form with hidden fields, `credential_0` (UČO) and `credential_1` (primary password). Submitting it with an in-memory cookie jar returns to the requested page. This account needed no second factor.

[`src/is/session.ts`](../src/is/session.ts) implements this. It logs in lazily, logs in again whenever IS redirects to the login form, follows at most 12 redirects across the two known HTTPS origins, and never forwards credentials across origins. Cookies stay in memory. Every visit to the login page issues a new form and invalidates the older ones, so parallel requests that each logged in would all fail (seen when an assistant calls several tools at once). Requests therefore wait for one shared login, which fetches its own form.

GET requests retry twice on a dropped connection or HTTP 409/502/503/504, and at most four requests run at once per session.

IS changes state through plain GET links, so the session refuses any URL containing `prihlasit=`, `odhlasit=` (exam registration) or `operace=` (actions such as toggling a favourite course). Under `/auth/mail`, which deletes and sends the same way, it allows only the two paths and the parameters the mail tools use. On `/auth/lide/lide_znami`, where links end friendships and cancel or send requests, it allows only the plain list and the `mafr`, `mafr_ok` and `x` parameters that `send_friend_request` uses. On the course catalogue's `predmety_ajax.pl`, which also stars courses and edits the course selection, it allows only `operace=get_courses`. Parameter names are decoded before these checks, so `%6Fperace=` counts as `operace=`. The only POST it sends is the login form.

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
- **Notebooks** (`/auth/student/poznamkove_bloky_nahled`, the current term without query parameters): one `li.ipb-seznam-pol#predmet_<id>` per course with a notebook, one `.ipb-pol` per notebook with `.ipb-nazev`, raw content in `.ipb-obsah pre`, and `.ipb-zmeneno` (changed, by). By IS convention `*N` marks points and `@X` a final grade. `.ipb-obsah-feedback` appears on notebooks with an attached submission folder and links the student's files as `/auth/el/.../ode/...`.

## Study check (`/auth/student/moje_kontrola_studia`)

Verified on 6 November 2026. [`src/is/study-check.ts`](../src/is/study-check.ts) implements this as `check_study_requirements`.

- **Templates:** with `fakulta` and `studium` only, the page is a form. The study's templates (kontrolní šablony) are checkboxes, `sabprokon_p` for mandatory ones, after a hidden `exppar_sabprokon` holding the study ID. This account had no supplementary templates, so their field name is assumed to follow the same `sabprokon_<x>` pattern. A URL with another study's ID showed the current study instead.
- **Check:** the form is a POST, but the same fields as a GET work: `?fakulta;studium;exppar_sabprokon=<study>;sabprokon_p=<template>;sabprokon_tl=Zkontrolovat studium`. The result is a flat run of rows inside the form, each ending in `<br>`: a `<tt>` indent of two `&nbsp;` per level, a marker (`font` green "o" met, red "x" unmet, blue "o" met in another study, `span.maybe` "?" enrolled now), then a `b`. A block's `b` holds its name, followed by "– rule" ("vše", "všech 11", "alespoň 1 z 2", "alespoň 17 kr."). A course's `b` holds a link to its catalogue page, followed by its name, an optional `<i>` with the completion and credits ("zk (4 kr.)"), and an optional "[ pož. ukončení: z, kredity: 16 ]". The same course can appear in several blocks. The page has no credit totals.
- **Not used:** checking against any other template (`vybkonsab_*`), and the flat list of required courses (`zspp=Zobrazit`), which repeats the tree's courses without their status.

## Study materials

- **Overview** (`/auth/student/studijni_materialy`): `h2` sections, each followed by a list or a "none" note: interactive syllabi, unread-file counts per course, open submission folders (odevzdávárny) with "(do D. M. YYYY vč.)", and all courses with materials (folder in the link's `furl`).
- **Files** come from the documented File Manager API, `/auth/dok/fmgr_api?url=<folder>`, as XML. Each `uzel` lists its `poduzly/poduzel` subfolders, each with its own `objekty/objekt` files (`jmeno_souboru`, `mime_type`, `velikost`, `vlozeno` as local time, `vlozil_jmeno`, `cesta`). Numbered subfolders have no `nazev`. Objects with mime `my/url` are links whose target is the file name. Recorded lectures are `video/mp4` objects named `video.fi.muni.cz?id=…;file=…`. Both have no `velikost`, and their `cesta` is a folder ending in `/`, so they have no file to download. `index.qwarp` (an interactive syllabus) can appear in more than one response, so the listing removes duplicates. Many lecture PDFs have a `.txt` version.
- **Downloads** come from `/auth<cesta>`, with the file's real `Content-Type`; a missing file is HTTP 404. Files reach several GB, so `download_file` streams to disk with a size limit. It logs in on a small page first, because logging in returns to the requested URL. It refuses anything outside `/el/<faculty>/<period>/<course>/` and anything under `odp/`. Folders carry a `mam_precteno` flag. Downloading from a folder with the flag set left the course's unread count unchanged; whether downloading an unread file marks it as read was not tested.

## Course catalogue

Verified on 6 November 2026. [`src/is/catalogue.ts`](../src/is/catalogue.ts) implements this as `search_courses` and `get_course`.

- **Search** (`/auth/predmety/`): the page is a JavaScript app that POSTs to `/auth/predmety/predmety_ajax.pl`, but a GET works the same: `?operace=get_courses;filters=<JSON>;search_text=<text>`. `filters` takes faculty IDs and Czech term names, such as `{"faculties":["1433"],"terms":["jaro 2027"]}`; a faculty code instead of the ID finds nothing. Without a term it searches the courses currently offered. The JSON answer has `count` and `table_tr`, one HTML row per course: `a.course_link` (the code, prefixed "FI:" when the search spans faculties, linking `/auth/predmet/<faculty>/<term>/<code>`), `.radek-nazev-label` ("Name (jaro 2027)"), and the teachers, one per line, in `.td_teachers [title]`. It returns at most 300 rows; the browser loads more with `get_courses_next`, which needs the whole result list sent back, so the tool reports `complete: false` instead. The `pvysl` parameter (the app's result set) is not needed. The shareable link `katalog?volby=…` only pre-fills the filters, and `katalog_data`, which lists the filter options, answers 403 outside the app.
- **Other operations** on the same endpoint change things: `add_course`, `remove_course` (the course selection), `hvezdicka` and the course page's `akce=oblib` (favourites), and `my_filters` (saved filters). The session refuses them.
- **Course page** (`/predmet/<faculty>/<term>/<code>`; `/auth/predmet/...` redirects there): an `h2` with the code and name (plus a favourite star in a `span`), the faculty in `b`, the term as text, then a `dl` whose `dt`/`dd` pairs are the sections (Rozsah, Vyučující, Garance, Rozvrh, Předpoklady, Anotace, Klíčová témata…); which sections appear varies by course. Without a term, `/predmet/fi/PA015` shows the current offering. A term the course isn't taught in is HTTP 404. URLs use faculty slugs (`fi`) that differ from the codes for some faculties, so `get_course` takes the link from a catalogue search rather than building it.
- **Not used:** the full listing (`/auth/predmety/uplny_vypis`), which works from the course selection, and the course page's enrolment statistics and seminar-group links.

## Online tests (`/auth/elearning/test_pruchod_el_student`)

One `.seznam-odp-predmet` block per course with `table.data3` rows: name and link (`td.uzel`), result (`td.hodn-pb`), status as the icon title in `td.budik`, and the window as `od`/`do` wrappers around `.odp_date_time`. Rows with class `odp_bez_prav` are not accessible. Courses with very many tests are listed in `.zdurazneni.upozorneni` instead; showing them needs `prepocitat_vsechno=1`, a recount over five minutes long, which is never requested. Test links only select a test and are never followed.

## Mail (`/auth/mail/`)

Verified on 4 November 2026. [`src/is/mail.ts`](../src/is/mail.ts) implements this as `list_emails`, `read_email` and `download_email_attachment`.

- **Folder page** (`/auth/mail/?folder_id=<id>;order_by=datum;desc=1;all=1`): each folder has hidden inputs `<id>_nazev` (name), `<id>_typ` (`INBOX`, `INBOX_RO`, `SENT`, `BAD`, `TRASH`, `USER`) and `<id>_pocty` ("unread/total"). Each message is a `tr#mail_<id>` with seven cells: checkbox, flags (`data-from_adr` holds the sender's address), empty, correspondent, subject (`a#read_link_<id>`), date, size. Class `riadok_new` marks unread.
- **Paging is browser-side.** The largest folder tested (123 messages) came back whole, and `start`/`count` changed nothing, so the `jsStart`/`jsCount` in the page's URL hash only pick which rows to show. `list_emails` slices the list itself and sets `complete: false` if IS ever returns fewer rows than the folder's total. Folders much larger than this were not tested.
- **List rows are approximate.** Subjects are shortened with an ellipsis. Dates are relative ("dnes 9:15", "včera 18:02", "Po 3. 11."), so older ones have no time and their year is inferred. In sent mail the correspondent is the recipient. The raw message has the exact values.
- **Raw message** (`/auth/mail/download?slozka=<folder>;select-mail=<id>;download=1`): `message/rfc822` in mbox format, starting with an envelope `From ` line, parsed with `postal-mime`. Attachments are taken from it too, so there is one source and no scraping. An unknown ID gives HTTP 200 with an HTML page, so the content type has to be checked.
- **Not used:** the rendered message (`?show_mail=<id>`), which could trip the session's password-field login check if an HTML email contains a password input, and single-part links (`download.pl/<name>?download=1;select-mail=<id>:<part>;slozka=<folder>`). The browser app's `mail_ajax` endpoint also carries the delete and send actions, such as `akce=drop_message`, and the session refuses it.
- **Read status:** listing folders and opening already-read messages left the unread set unchanged. Whether the raw download marks an unread message as read was not tested, because that test would change the account's state, so the tools say that it may.

## People

Verified on 5 November 2026. [`src/is/people.ts`](../src/is/people.ts) implements this as `list_friends`, `search_people` and `send_friend_request`.

- **Moji známí** (`/auth/lide/lide_znami`): `#edit_nav` holds IS's counts ("Seznam osob (34 známých + 15 požádaných)"), which the parser checks its rows against. Under the `h3` "Moji známí", each `.clen_info` row has the name in `b`, "učo N" in `.nedurazne`, the address in a `mail_posli?to=` link, and "naposledy v IS: D. M. YYYY[ H:MM]". Under "Lidé požádáni…", each `li` has the name and UČO. Requests sent to you should appear under a heading the help page calls "Lidé, kteří požádali…"; this account had none, so that section's layout is assumed to match.
- **Actions take two GETs.** `mafr=<učo>` (send) and `care=<učo>` (cancel) only show a confirmation page: `h3`, the person's `.clen_info`, and a link, "ano, opravdu požádat" or "ano, opravdu zrušit", to `mafr_ok=1;mafr=<učo>;x=<token>` or `care_ok=1;care=<učo>;x=<token>`. Opening that link does it. `cafr=<učo>` ends a friendship and was not followed. `send_friend_request` reads the confirmation link from the page, checks its UČO, and then checks the list. The session refuses `care` and `cafr`.
- **Refusals** come back as the normal list with a `.zdurazneni` note, such as "Nemůžete navázat známost sám se sebou" for your own UČO.
- **A person's friends** (`?zn_uco=<učo>`) work only for your own friends; for anyone else, IS shows your own list with the note "Vybraná osoba není Váš známý, ignoruji". No tool uses this.
- **People search** (`/auth/vyhledavani/?search=<text>;ag=os;start=<page>`): a GET returning `.vyh_polozka.lide` rows with the name in `h4 a`, "(učo N)" beside it, and details in `.vyh_hlavicky`. `start` is a page number, with 10 rows per page; `.strankovani` links to the other pages. Profile links can use a login name rather than a UČO, but `/auth/osoba/<učo>` also works. Different people can share a name exactly. The form on `/auth/lide/` does not return results without its JavaScript, so it isn't used.

## Not covered yet

Second-factor login, IS reminders (`/auth/student/is_pripomina`, empty for this account, so its structure is unknown), recorded lecture videos, Poskytovny (`/auth/of/...`), and grades from earlier semesters.
