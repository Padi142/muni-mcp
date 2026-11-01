import assert from "node:assert/strict";
import test from "node:test";
import { parseGradesPage, parseNotebooksPage } from "./grades.js";

// Synthetic markup follows the observed structure without storing student HTML.
const row = (course: string, credits: string, grade: string, cls = "", rest = "<td></td><td></td><td></td>") =>
  `<tr class='elem_vybrane_obdobi'><td><B><A href='#'>${course}</A> </B>Course name</td><td>${credits}</td><td>zk</td>
    <td class='${cls}'><strong><span class='show-for-sr'>Hodnocení: </span>${grade}</strong></td>${rest}</tr>`;

test("parses grades with pass state, date, note, and semester credits", () => {
  const result = parseGradesPage(`<main id="app_content"><table class='data3'>
    <tr class='elem_vybrane_obdobi'><td colspan='7'><span class='table_obdobi_nadpis'>podzim 2026</span></td></tr>
    <tr class='elem_vybrane_obdobi'><th>Předmět</th></tr>
    ${row("FI:XY001", "4", "&nbsp;")}
    ${row("FI:XY002", "0", "E", "ok", "<td class='ok'>5. 10. 2026</td><td>uznáno</td><td>5. 10. 2026 09:17, <a>M.&nbsp;Teacher</a></td>")}
    ${row("FI:XY003", "2", "F", "ko")}
    </table><div class='elem_vybrane_obdobi_only'>Kredity v zobrazeném semestru:&nbsp;<B>4</B> z <B>6</B></div></main>`);
  assert.deepEqual([result.semester, result.earnedCredits, result.enrolledCredits], ["podzim 2026", 4, 6]);
  assert.deepEqual(result.courses.map((c) => [c.courseCode, c.faculty, c.grade, c.passed]), [
    ["XY001", "FI", null, null], ["XY002", "FI", "E", true], ["XY003", "FI", "F", false],
  ]);
  assert.deepEqual(result.courses[1], {
    courseCode: "XY002", faculty: "FI", name: "Course name", credits: 0, completionType: "zk", grade: "E",
    passed: true, gradedOn: "2026-10-05", note: "uznáno", enteredBy: "M. Teacher",
  });
});

test("reads notebook points (*N) and final grades (@X) per entry", () => {
  const entry = (name: string, content: string) => `<div class="ipb-pol"><div class="ipb-nazev">${name}</div>
    <div class="ipb-obsah"><div class="obsah"><pre>${content}</pre></div></div>
    <div class="ipb-zmeneno"><div>Změněno: 21. 10. 2026 21:20,</div> <div>M. Teacher</div></div></div>`;
  const [course] = parseNotebooksPage(`<main id="app_content"><ul>
    <li class="ipb-seznam-pol"><a class="accordion-title"><div class="row"><div class="column shrink"></div>
      <div class="column">XY001 Course name</div><div class="column shrink">Změněno</div></div></a>
      ${entry("HW", "1 | 1 | *2")}${entry("Bonus", "*1,5 *-0.5")}${entry("Final", "@A")}${entry("Note", "splněno")}
    </li></ul></main>`);
  assert.equal(course?.courseCode, "XY001");
  assert.equal(course?.name, "Course name");
  assert.deepEqual(course?.entries.map((e) => [e.name, e.points, e.finalGrade]), [
    ["HW", 2, null], ["Bonus", 1, null], ["Final", null, "A"], ["Note", null, null],
  ]);
  assert.equal(course?.entries[0]?.changed, "2026-10-21T21:20+02:00");
  assert.equal(course?.entries[0]?.changedBy, "M. Teacher");
});
