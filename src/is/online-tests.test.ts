import assert from "node:assert/strict";
import test from "node:test";
import { parseOnlineTests } from "./online-tests.js";

// Synthetic markup follows the observed structure without storing student HTML.
test("parses tests per course with windows, status, access, and hidden courses", () => {
  const result = parseOnlineTests(`<main id="app_content">
    <div class="zdurazneni upozorneni"><ul><li><strong>XY009: Big course</strong></li></ul></div>
    <div class="row seznam-odp-predmet"><div class="seznam-odp-head"><h2><span>XY001 Course one</span></h2></div>
      <table class="data3"><tbody>
        <tr class=""><td class="uzel"><a href="./test_pruchod_el_student?testurl=%2Fel%2Fx.qref">Final test</a></td>
          <td class="hodn-pb">8 b.</td><td class="budik"><i title="Odpovědník bude otevřen."></i></td>
          <td class="poznamka"><ul><li><div class="row">
            <div class="column">od&nbsp;<span class="odp_date_time"><span class="odp_date">Čt 7. 1. 2027</span> <span class="odp_time">9:00</span></span></div>
            <div class="column">do&nbsp;<span class="odp_date_time"><span class="odp_date">Ne 7. 2. 2027</span> <span class="odp_time">23:59</span></span></div>
          </div></li></ul></td></tr>
        <tr class=" odp_bez_prav"><td class="uzel"><a href="#">Old exam</a></td><td class="hodn-pb"></td>
          <td class="budik"><i title="Nemáte oprávnění."></i></td><td class="poznamka">nemáte oprávnění</td></tr>
      </tbody></table></div></main>`);
  assert.deepEqual(result.hiddenCourses, ["XY009"]);
  const [course] = result.courses;
  assert.deepEqual([course?.courseCode, course?.name], ["XY001", "Course one"]);
  assert.deepEqual(course?.tests[0], {
    name: "Final test", status: "Odpovědník bude otevřen", accessible: true,
    opens: "2027-01-07T09:00+01:00", closes: "2027-02-07T23:59+01:00", result: "8 b.", note: null,
    url: "https://is.muni.cz/auth/elearning/test_pruchod_el_student?testurl=%2Fel%2Fx.qref",
  });
  assert.deepEqual([course?.tests[1]?.accessible, course?.tests[1]?.note], [false, "nemáte oprávnění"]);
});
