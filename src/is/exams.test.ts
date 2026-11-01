import assert from "node:assert/strict";
import test from "node:test";
import { parseExamOverview, parseExamSeries } from "./exams.js";
import { createIsSession } from "./session.js";
import { parseIsDate } from "./time.js";

const base = "https://is.muni.cz/auth/student/prihl_na_zkousky";
const ctx = "fakulta=1;obdobi=2;studium=3";

// Synthetic markup follows the observed structure without storing student HTML.
function details(when: string, extra = "") {
  return `<TD><B>${when}</B> (výhradně řádný), přihlášeno 5, max. 10<BR>
    <FONT SIZE=-1>přihlásit od Po 26. 10. 2026 17:00 do Ne 1. 11. 2026&nbsp;vč., odhlásit do Ne 1. 11. 2026&nbsp;vč.</FONT><BR>
    <FONT SIZE=-1>Bring ISIC.</FONT><BR>
    <FONT SIZE=-1><I>Zadáno: 19. 10. 2026 07:51, V. Učitel, učo <a href="/auth/osoba/1">1</a></I></FONT>
    ${extra}</TD>`;
}
const signUp = (id: string) =>
  `<FONT SIZE=-1><A HREF="./prihl_na_zkousky?${ctx};predmet=9;zkt=${id};prihlasit=1"><I>zkusit se přihlásit</I></A></FONT>`;

test("parses the overview's registrations, series, and courses without terms", () => {
  const html = `<main id="app_content"><B>Nyní jste přihlášen na tyto termíny v budoucnosti:</B>
    <TABLE class=data1>
      <TR id="tr_odhl_7"><TD COLSPAN=2><B>XY001 Course - Midterm</B></TD></TR>
      <TR id="tr_odhl2_7"><TD class="ok"><A HREF="./prihl_na_zkousky?${ctx};predmet=9;zkt=7">podrobně</A></TD>${details("Po 2. 11. 2026 08:25 A217")}</TR>
    </TABLE>
    <p><B>Předměty a jejich série, ke kterým jsou vyhlášeny zkušební termíny v budoucnosti:</B>
    <UL><LI><A HREF="./prihl_na_zkousky?${ctx};predmet=9;serie=4"><B>XY001 Course - Midterm</B></A> (počet termínů: 3)</UL>
    <B>Předměty, ke kterým nejsou vyhlášeny zkušební termíny v budoucnosti:</B>
    <UL><LI>AB002 Plain course<LI><a href="./prihl_na_zkousky?${ctx};predmet=8;vse=1">CD003 Old course</a></UL></main>`;
  const result = parseExamOverview(html, base);
  const [term] = result.registered;
  assert.equal(term?.termId, "7");
  assert.equal(term?.start, "2026-11-02T08:25+01:00");
  assert.equal(term?.location, "A217");
  assert.deepEqual([term?.registeredCount, term?.capacity], [5, 10]);
  assert.deepEqual(term?.registration, { from: "2026-10-26T17:00+01:00", until: "2026-11-01" });
  assert.equal(term?.note, "Bring ISIC.");
  assert.equal(term?.announced, "19. 10. 2026 07:51, V. Učitel");
  assert.deepEqual(result.series.map((s) => [s.courseCode, s.seriesId, s.termCount]), [["XY001", "4", 3]]);
  assert.equal(result.series[0]?.url, `${base}?${ctx};predmet=9;serie=4`);
  assert.deepEqual(result.withoutTerms.map((c) => [c.courseCode, c.hasPastTerms]), [["AB002", false], ["CD003", true]]);
  assert.throws(() => parseExamOverview('<main id="app_content"></main>', base), /layout changed/);
});

test("parses series terms, their registration state, and never exposes action links", () => {
  const row = (state: string, cls: string, id: string, when: string) =>
    `<TR><TD>${state}</TD><TD class="${cls}"><A HREF="./prihl_na_zkousky?${ctx};predmet=9;zkt=${id}">podrobně</A></TD>${details(when, signUp(id))}</TR>`;
  const html = `<main id="app_content"><H2>XY001 Course - Midterm</H2>
    <B>Maximální počet možných souběžných přihlášení v budoucnosti:</B> 1<br>
    <TABLE class="data1">
      ${row("<B>přihlášen</B>", "ok", "1", "Po 2. 11. 2026 08:00 A217")}
      ${row("nejste<BR>přihlášen", "stav1", "2", "Po 6. 7. 2026 08:00 106 (room note)")}
      ${row("nejste<BR>přihlášen", "ko", "3", "Po 2. 11. 2026 09:00 A217")}
    </TABLE></main>`;
  const result = parseExamSeries(html, `${base}?${ctx};predmet=9;serie=4`);
  assert.equal(result.maxConcurrentRegistrations, 1);
  assert.deepEqual(result.terms.map((t) => [t.registered, t.action]), [
    [true, "available"], [false, "available-after-unregistering"], [false, "unavailable"],
  ]);
  assert.equal(result.terms[1]?.start, "2026-07-06T08:00+02:00");
  assert.equal(result.terms[1]?.location, "106 (room note)");
  assert.equal(result.terms[0]?.note, "Bring ISIC.");
  assert.ok(result.terms.every((t) => !/prihlasit|odhlasit/.test(t.url)));
});

test("the session refuses registration-changing URLs before any request", async () => {
  const session = createIsSession({ username: "x", password: "y" });
  await assert.rejects(session.getPage(`${base}?${ctx};zkt=1;odhlasit=1`), /changes data/);
  await assert.rejects(session.getPage(`${base}?${ctx};zkt=1;prihlasit=1`), /changes data/);
});

test("IS dates resolve to Europe/Prague across DST", () => {
  assert.equal(parseIsDate("Ne 29. 3. 2026 03:30"), "2026-03-29T03:30+02:00");
  assert.equal(parseIsDate("So 24. 10. 2026 12:00"), "2026-10-24T12:00+02:00");
  assert.equal(parseIsDate("1. 11. 2026"), "2026-11-01");
  assert.equal(parseIsDate("no date"), null);
});
