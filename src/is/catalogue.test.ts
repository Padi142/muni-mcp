import assert from "node:assert/strict";
import test from "node:test";
import { fetchCourse, parseCoursePage, parseTerm, searchCourses } from "./catalogue.js";

// Synthetic markup follows the observed structure without storing real pages.
const row = (code: string, term: string, slug = "fi", teachers = "Teacher A \nTeacher B ") => `
  <div class="cat-result-radek can_select"><div class="column td_name medium-shrink">
    <span title="x"><strong><a class="course_link" href="/auth/predmet/${slug}/${term.replace(" ", "")}/${code.split(":").at(-1)}">${code}</a></strong>
    <label class="radek-nazev-label">Course ${code} (${term})</label></span></div>
    <div class="column td_star shrink"><button class="course-star hvezdicka" data-code="${code}"></button></div>
    <div class="column td_teachers shrink"><div class="left" title="${teachers}"></div></div></div>`;

function searchSession(rows: string[], count = rows.length, pages: Record<string, string> = {}) {
  const requested: string[] = [];
  return {
    requested,
    getPage: async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      return { url: new URL(url), html: pages[url] ?? JSON.stringify({ status: 1, count, table_tr: rows }) };
    },
  };
}

test("reads Czech and English term names", () => {
  assert.deepEqual(["jaro 2027", "Spring2027", "fall 2026", "podzim  2026"].map(parseTerm), ["jaro 2027", "jaro 2027", "podzim 2026", "podzim 2026"]);
  assert.throws(() => parseTerm("2026"), /Unknown term/);
});

test("searches with the catalogue's own filters and pages the results", async () => {
  const session = searchSession([row("PA001", "jaro 2027"), row("PA002", "jaro 2027"), row("PA003", "jaro 2027")], 400);
  const result = await searchCourses(session, { query: " AI;operace=x ", faculty: "FI", term: "spring 2027", page: 2, pageSize: 2 });
  assert.equal(
    session.requested[0],
    `https://is.muni.cz/auth/predmety/predmety_ajax.pl?operace=get_courses;filters=${encodeURIComponent('{"faculties":["1433"],"terms":["jaro 2027"]}')};search_text=AI%3Boperace%3Dx`,
  );
  assert.deepEqual([result.total, result.totalPages, result.complete], [400, 2, false]);
  assert.deepEqual(result.courses, [
    { code: "PA003", faculty: "FI", name: "Course PA003", term: "jaro 2027", teachers: ["Teacher A", "Teacher B"], url: "https://is.muni.cz/auth/predmet/fi/jaro2027/PA003" },
  ]);
  await assert.rejects(searchCourses(session, { query: " " }), /Give a query/);
});

test("takes the faculty from the code when the search spans faculties", async () => {
  const { courses } = await searchCourses(searchSession([row("PřF:C1234", "podzim 2026", "sci")]), { query: "C1234" });
  assert.deepEqual([courses[0]?.code, courses[0]?.faculty], ["C1234", "PřF"]);
});

const coursePage = `<main id="app_content"><script>predm_ajax()</script>
  <H2>XY015 Some Course <span id="pr_ob_XY015"><a onclick="predm_ajax('oblib')"><img alt="star"></a></span></h2>
  <B>Fakulta informatiky</B><BR>podzim 2026
  <DL>
  <DT><B>Rozsah</B></DT><DD>2/0/0. 2 kr. (plus ukončení). Ukončení: zk.<br/>Vyučováno kontaktně</DD>
  <DT><B>Anotace</B></DT><DD>A long annotation
    wrapped in the source. <br><br> Second paragraph.</DD>
  <DT><B>Klíčová témata</B></DT><DD>Topics:<ul>
    <li>One</li>
    <li>Two <br><br> continued</li> </ul>Timeline</DD>
  <DT><B>Další komentáře</B></DT><DD><A HREF="/auth/el/fi/podzim2026/XY015/">Studijní materiály</A><BR>Každoročně.</DD>
  </DL><HR><UL><LI>Permalink: <span class="nedurazne">https://is.muni.cz/auth/predmet/fi/podzim2026/XY015</span></li></UL></main>`;

test("reads a course page's sections as text", () => {
  assert.deepEqual(parseCoursePage(coursePage), {
    code: "XY015",
    name: "Some Course",
    faculty: "Fakulta informatiky",
    term: "podzim 2026",
    url: "https://is.muni.cz/auth/predmet/fi/podzim2026/XY015",
    materials: "https://is.muni.cz/auth/el/fi/podzim2026/XY015/",
    sections: {
      Rozsah: "2/0/0. 2 kr. (plus ukončení). Ukončení: zk.\nVyučováno kontaktně",
      Anotace: "A long annotation wrapped in the source.\n\nSecond paragraph.",
      "Klíčová témata": "Topics:\n- One\n- Two\n\ncontinued\n\nTimeline",
      "Další komentáře": "Studijní materiály\nKaždoročně.",
    },
  });
  assert.throws(() => parseCoursePage(`<main id="app_content"><h2>Nothing</h2></main>`), /no heading or sections/);
});

test("finds a course's page by its exact code, noting the other terms", async () => {
  const url = "https://is.muni.cz/auth/predmet/fi/podzim2026/XY015";
  const session = searchSession([row("XY0150", "podzim 2026"), row("XY015", "podzim 2026"), row("XY015", "jaro 2027")], 3, { [url]: coursePage });
  const course = await fetchCourse(session, { code: "fi:xy015" });
  assert.deepEqual([course.code, course.term, course.otherTerms], ["XY015", "podzim 2026", ["jaro 2027"]]);
  assert.equal(session.requested.at(-1), url);
  assert.match(session.requested[0] ?? "", /filters=%7B%22faculties%22%3A%5B%221433%22%5D%7D;search_text=xy015$/);
});

test("says when a code is missing or ambiguous instead of guessing", async () => {
  await assert.rejects(fetchCourse(searchSession([row("XY0150", "jaro 2027")]), { code: "XY015", term: "jaro 2027" }), /No course XY015 in the catalogue for jaro 2027/);
  const twoFaculties = searchSession([row("FI:XY015", "jaro 2027"), row("FF:XY015", "jaro 2027", "phil")]);
  await assert.rejects(fetchCourse(twoFaculties, { code: "XY015" }), /several faculties: FI, FF/);
  await assert.rejects(fetchCourse(twoFaculties, { code: "ZZ:XY015" }), /Unknown course code/);
  await assert.rejects(fetchCourse(twoFaculties, { code: "XY015;akce=oblib" }), /Unknown course code/);
});
