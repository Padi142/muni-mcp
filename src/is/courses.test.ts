import assert from "node:assert/strict";
import test from "node:test";
import { parseCoursesPage } from "./courses.js";

const url = "https://is.muni.cz/auth/student/zapis?fakulta=1433&studium=1&obdobi=2";

// Synthetic markup follows the observed structure without storing student HTML.
function card(status: string, credits: string, courseId = "100", facultyId = "1433") {
  return `<div class="rpa-predmet" data-fakulta-id="${facultyId}"
    data-predmet-id="${courseId}" data-stav="${status}" data-ukonceni="zk">
    <div class="nazev-predmet">
      <a class="jen-kod" href="/auth/predmet/fi/podzim2026/TEST_01">TEST_01</a>
      <span class="jen-nazev">A &amp; B</span>
    </div>
    <span class="kr-aktualne">${credits}</span>
  </div>`;
}

function page(enrolled = "", registered = "") {
  return `<main id="app_content"><div class="registrace-predmetu-app">
    <div id="rpa-predmety-pripraveno"></div>
    <div id="rpa-predmety-zaregistrovano">${registered}</div>
    <div id="rpa-predmety-zapsano">${enrolled}</div>
  </div></main>`;
}

test("parses offerings across faculties, preserves zero credits, and separates registration from enrolment", () => {
  const result = parseCoursesPage(page(
    card("zapsano", "0") + card("zapsano", "2,5", "200", "1421"),
    card("zaregistrovano", "6", "300"),
  ), url);
  assert.deepEqual(result.counts, { prepared: 0, registered: 1, enrolled: 2 });
  assert.equal(result.enrolledCredits, 2.5);
  assert.equal(result.courses.find((course) => course.courseId === "200")?.facultyId, "1421");
  const zeroCreditCourse = result.courses.find((course) => course.courseId === "100");
  assert.equal(zeroCreditCourse?.credits, 0);
  assert.equal(zeroCreditCourse?.name, "A & B");
  assert.equal(zeroCreditCourse?.url, "https://is.muni.cz/auth/predmet/fi/podzim2026/TEST_01");
});

test("distinguishes an empty enrolment page from a login page or missing sections", () => {
  assert.equal(parseCoursesPage(page(), url).courses.length, 0);
  assert.throws(() => parseCoursesPage('<input type="password">', url), /authenticated/);
  assert.throws(() => parseCoursesPage(page().replace('id="rpa-predmety-zapsano"', ''), url), /layout changed/);
});

test("rejects incomplete or conflicting records instead of returning misleading results", () => {
  assert.throws(() => parseCoursesPage(page(card("zapsano", "")), url), /missing credits/);
  assert.throws(() => parseCoursesPage(page(card("zapsano", "unknown")), url), /credit value/);
  assert.throws(() => parseCoursesPage(page(card("pripraveno", "4")), url), /status/);
  assert.throws(() => parseCoursesPage(page(card("zapsano", "4") + card("zapsano", "4")), url), /duplicate/);
});
