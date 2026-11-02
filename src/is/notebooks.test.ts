import assert from "node:assert/strict";
import test from "node:test";
import { parseNotebooksPage } from "./notebooks.js";

// Synthetic markup follows the observed structure without storing student HTML.
const entry = (name: string, content: string, feedback = "") => `<div class="ipb-pol"><div class="ipb-nazev">${name}</div>
  <div class="ipb-obsah"><div class="obsah"><pre>${content}</pre></div>${feedback}</div>
  <div class="ipb-zmeneno"><div>Změněno: 21. 10. 2026 21:20,</div> <div>M. Teacher</div></div></div>`;
const page = (entries: string) => `<main id="app_content"><ul>
  <li class="ipb-seznam-pol" id="predmet_42"><a class="accordion-title" href="#"><div class="row"><div class="column shrink"></div>
    <div class="column">XY001 Course name</div><div class="column shrink">Změněno</div></div></a>
    ${entries}
  </li></ul></main>`;

test("reads notebook points (*N) and final grades (@X) per entry", () => {
  const [course] = parseNotebooksPage(page(
    entry("HW", "1 | 1 | *2") + entry("Bonus", "*1,5 *-0.5") + entry("Final", "@A") + entry("Note", "splněno"),
  ));
  assert.equal(course?.courseCode, "XY001");
  assert.equal(course?.name, "Course name");
  assert.equal(course?.url, "https://is.muni.cz/auth/student/poznamkove_bloky_nahled#predmet_42");
  assert.deepEqual(course?.entries.map((e) => [e.name, e.points, e.finalGrade]), [
    ["HW", 2, null], ["Bonus", 1, null], ["Final", null, "A"], ["Note", null, null],
  ]);
  assert.equal(course?.entries[0]?.changed, "2026-10-21T21:20+02:00");
  assert.equal(course?.entries[0]?.changedBy, "M. Teacher");
});

test("lists submitted files as paths for download_file, ignoring the section toggle", () => {
  const feedback = `<div class="ipb-obsah-feedback"><a href="#" class="rozklikavatko-nadpis">Moje soubory</a>
    <div class="rozklikavatko-obsah"><ul><li><a target="_blank" href="/auth/el/fi/podzim2026/XY001/ode/hw1/my%20hw.txt">my hw.txt</a></li></ul></div></div>`;
  const [course] = parseNotebooksPage(page(entry("HW", "*2", feedback) + entry("Quiz", "*1")));
  assert.deepEqual(course?.entries.map((e) => e.submittedFiles), [
    [{ name: "my hw.txt", path: "/el/fi/podzim2026/XY001/ode/hw1/my hw.txt" }],
    [],
  ]);
});
