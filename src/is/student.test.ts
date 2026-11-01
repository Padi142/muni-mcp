import assert from "node:assert/strict";
import test from "node:test";
import { parseCourseCards, parseCourseInfo } from "./courses.js";
import { parseStudentEvents } from "./deadlines.js";
import { parseAjaxHtml, parseStudentContext, studentAjaxUrl } from "./student.js";

// Synthetic markup follows the observed structure without storing student HTML.
const card = (id: string, faculty: string, code: string, name: string, done = false) => `
  <div class='predmet_conteiner'><div class='predmet_header'>
    <a class='predmet_header_more rozbal' href="#" id='predmet-button-${id}'>
      <span class='predmet_header_name'><img src='/pics/design/r6/loga/${faculty}.svg' alt='' /> <strong>${code}</strong> ${name}</span>
      ${done ? `<span class="isi-potvrzeni ok" title="Předmět úspěšně ukončen"></span>` : ""}
    </a></div></div>`;

const studentPage = (cards: string) => `<main id="app_content">
  <form role="search"><INPUT TYPE=hidden NAME="fakulta" VALUE="1"><INPUT TYPE=hidden NAME="obdobi" VALUE="2"><INPUT TYPE=hidden NAME="studium" VALUE="3"></form>
  <div id="tab-content-predmety-subcontent"><h2>Moje předměty</h2>${cards}</div></main>`;

test("reads the study context and course cards from the student page", () => {
  const html = studentPage(card("10", "1433", "XY001", "Neural &amp; Networks") + card("11", "1421", "AB002", "Vikings", true));
  assert.deepEqual(parseStudentContext(html), { facultyId: "1", periodId: "2", studyId: "3" });
  assert.deepEqual(parseCourseCards(html), [
    { courseId: "10", facultyId: "1433", code: "XY001", name: "Neural & Networks", completed: false },
    { courseId: "11", facultyId: "1421", code: "AB002", name: "Vikings", completed: true },
  ]);
  assert.throws(() => parseStudentContext('<input type="password">'), /authenticated/);
  assert.throws(() => parseCourseCards("<main id='app_content'></main>"), /layout changed/);
});

test("reads a course's info panel", () => {
  const info = parseCourseInfo(`<div class='row student_row_a'>
    <div class='column'><div><span class='podnadpis'>Vyučující</span><span class='vyucujici'><a href="#">A. Teacher</a>, <a href="#">B. Other</a></span></div>
      <span class='podnadpis'>Rozvrh</span>Po 8:00–9:50 A217</div>
    <div class='column shrink'><div class='hodnoceni'>
      <span title="Získané hodnocení"><span class="show-for-sr">Získané hodnocení: </span>A</span>
      <span title="Počet kreditů"><span class="show-for-sr">Počet kreditů: </span>2,5 <span class="male">kr.</span></span>
      <span title="Ukončení"><span class="show-for-sr">Ukončení: </span>zk</span></div></div></div>
    <a href='/auth/el/1433/podzim2026/XY001/'><div class='pocet_nectene2'><span class='show-for-sr'>Počet: </span>5</div>Materiály</a>
    <a href='/predmet/fi/podzim2026/XY001'>Katalog</a>`);
  assert.deepEqual(info.teachers, ["A. Teacher", "B. Other"]);
  assert.equal(info.schedule, "Po 8:00–9:50 A217");
  assert.deepEqual([info.grade, info.credits, info.completionType, info.unreadMaterials], ["A", 2.5, "zk", 5]);
  assert.equal(info.links.materials, "https://is.muni.cz/auth/el/1433/podzim2026/XY001/");
  assert.equal(info.links.forum, null);
});

test("parses current and upcoming events, pairing headers with their details", () => {
  const html = parseAjaxHtml(JSON.stringify({ html: `
    <div class='stud_udalosti-ted'><h3>DNES 31. prosince</h3>
      <div class='row'><div class='column'>Zkoušky</div><div class='column stud_udalosti-box'>
        <div class='row stud_udalosti_header'><div class='column'></div><div class='column'><span><a href='/auth/student/prihl_na_zkousky?predmet=1;serie=2'>odhlásit z termínu zkoušky XY001</a></span></div></div>
        <div class='row stud_udalosti_content'><div class='column'><span class='stud_udalosti-do'>23:59</span></div>
          <div class='column'><span>2. 1. 2027 08:25</span><span class='stud_udalosti-mistnost'>(A217, <span class='stud_udalosti-rozsah'>do 31. 12. 2026&nbsp;vč.</span>)</span></div></div>
      </div></div></div>
    <div class='stud_udalosti-ceka'><h3>Pátek 1. ledna</h3>
      <div class='row'><div class='column'>Odpovědníky</div><div class='column stud_udalosti-box'>
        <div class='row stud_udalosti_content'><div class='column'><span class='stud_udalosti-od'>00:01</span><span class='stud_udalosti-do'>&nbsp;</span></div>
          <div class='column'><span><a href="/auth/elearning/test">Odpovědník otevřen XY001: Quiz</a></span>
            <span class='stud_udalosti-predmet'>XY001 Course</span><span class='stud_udalosti-osoba'>Dr. Teacher, učo 123</span>
            (<span class='stud_udalosti-rozsah'>od 1. 1. 2027 do 15. 1. 2027&nbsp;vč.</span>)</div></div>
      </div></div>
      <div class='row'><div class='column'>Rozvrh</div><div class='column stud_udalosti-box'>
        <div class='row stud_udalosti_content'><div class='column'><span class='stud_udalosti-od'>08:00</span><span class='stud_udalosti-do'>09:50</span></div>
          <div class='column'><span>XY001 Course</span><span class='stud_udalosti-mistnost'>(106 (accessible))</span></div></div>
      </div></div></div>` }));
  const [exam, quiz, lecture] = parseStudentEvents(html, "2026-12-31");
  assert.equal(exam?.title, "odhlásit z termínu zkoušky XY001");
  assert.equal(exam?.end, "2026-12-31T23:59+01:00");
  assert.equal(exam?.eventAt, "2027-01-02T08:25+01:00");
  assert.equal(exam?.location, "A217");
  assert.deepEqual(exam?.range, { from: null, until: "2026-12-31" });
  // The year rolls over for headings after New Year.
  assert.equal(quiz?.day, "2027-01-01");
  assert.equal(quiz?.start, "2027-01-01T00:01+01:00");
  assert.equal(quiz?.end, null);
  assert.deepEqual(quiz?.range, { from: "2027-01-01", until: "2027-01-15" });
  assert.equal(quiz?.person, "Dr. Teacher");
  assert.equal(quiz?.url, "https://is.muni.cz/auth/elearning/test");
  assert.equal(lecture?.location, "106 (accessible)");
  assert.equal(lecture?.category, "Rozvrh");
});

test("only builds read-only AJAX URLs with IS-style separators", () => {
  assert.equal(studentAjaxUrl("udalosti-init", { obdobi: "2", studium: "3" }),
    "https://is.muni.cz/auth/student/index_ajax?obdobi=2;studium=3;option=udalosti-init");
});

test("parses recent changes, whose year comes from the month heading", () => {
  const events = parseStudentEvents(`<div class='stud_udalosti-ceka'></div><div class='stud_udalosti-posledni'>
    <h3>Prosinec 2026</h3>
    <div class='row'><div class='column'>Středa 30. 12.</div><div class='column stud_udalosti-box'>
      <div class='row stud_udalosti_content'><div class='column'><span class='stud_udalosti-od'>21:18</span></div>
        <div class='column'><span class='stud_udalosti-bloky'><a href='/auth/student/poznamkove_bloky_nahled.pl'>Poznámkový blok HW03</a></span>
          <span class='stud_udalosti-predmet'>XY001 Course</span><span class='stud_udalosti-osoba'>Dr. Teacher, učo 1</span></div></div>
    </div></div>
    <a class='nedurazne' href='#'>Více</a></div>`, "2027-01-02");
  assert.deepEqual(events.map((e) => [e.section, e.day, e.category, e.title, e.start, e.course, e.person]), [
    ["recent", "2026-12-30", null, "Poznámkový blok HW03", "2026-12-30T21:18+01:00", "XY001 Course", "Dr. Teacher"],
  ]);
});
