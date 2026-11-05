import assert from "node:assert/strict";
import test from "node:test";
import { fetchFriends, parseFriends, parsePeopleSearch, parseRequestConfirmation, searchPeople, sendFriendRequest } from "./people.js";

// Synthetic markup follows the observed structure without storing real people.
const friend = (uco: number, seen: string) => `
  <div class="clen_info"><a href="/auth/osoba/${uco}"><img alt="x"></a><b>Person ${uco}</b>, <span class="nedurazne">učo ${uco}</span>
  <br><a href="/auth/mail/mail_posli?to=p${uco}%40example.org;subject=">e-mail</a> | <a href="../lide/lide_aktivita?uco=${uco}">aktivita</a>
  | <a href="./lide_znami?zn_uco=${uco}">známí</a> | naposledy v IS: ${seen}<br> <a href="./lide_znami?cafr=${uco}">zrušit známost</a></div>`;

const request = (uco: number) =>
  `<li><b>Person ${uco}</b>, <span class="nedurazne"><a href="/auth/osoba/${uco}">${uco}</a></span> <a href="./lide_znami?care=${uco}">zruš požadavek</a></li>`;

const page = (known: string[], sent: string[], extra = "") => `<main id="app_content">
  <p id="edit_nav"><b>Seznam osob (${known.length} známých + ${sent.length} požádaných)</b> | <a href="./lide_znami?zobrazeni=k">Seznam dle Kruhů lidí</a> (0 kruhů)</p>
  ${extra}
  <h3>Moji známí</h3><ul>${known.join("")}</ul><script>x()</script><br>
  <h3>Lidé požádáni, aby byli mými známými: ${sent.length}</h3><a class="rozbal">rozbalit</a><div><ul>${sent.join("")}</ul></div>
</main>`;

test("reads friends and sent requests, keeping the sections apart", () => {
  const result = parseFriends(page([friend(11, "4. 11. 2026 10:20"), friend(12, "3. 9. 2025")], [request(13)]));
  assert.deepEqual(result.friends, [
    { uco: "11", name: "Person 11", email: "p11@example.org", lastSeen: "2026-11-04T10:20+01:00", profile: "https://is.muni.cz/auth/osoba/11" },
    { uco: "12", name: "Person 12", email: "p12@example.org", lastSeen: "2025-09-03", profile: "https://is.muni.cz/auth/osoba/12" },
  ]);
  assert.deepEqual(result.requestsSent, [{ uco: "13", name: "Person 13", email: null, lastSeen: null, profile: "https://is.muni.cz/auth/osoba/13" }]);
  assert.deepEqual(result.requestsReceived, []);
});

test("lists requests waiting for you", () => {
  const extra = `<h3>Lidé, kteří požádali o to být Moji známí</h3><ul>${request(14)}</ul>`;
  assert.deepEqual(parseFriends(page([], [], extra)).requestsReceived.map((p) => p.uco), ["14"]);
});

test("reports a changed page instead of an empty list", () => {
  assert.throws(() => parseFriends(`<main id="app_content"></main>`), /no person counts/);
  const wrongCount = page([friend(11, "4. 11. 2026")], []).replace("1 známých", "2 známých");
  assert.throws(() => parseFriends(wrongCount), /don't match/);
});

const result = (uco: number) => `<div class="vyh_polozka lide" data-agenda="L"><h4><a href="/auth/osoba/person.${uco}">Mgr. Person <span class="highlight">${uco}</span></a></h4>
  (učo ${uco})<div class="vyh_hlavicky"><a href="/auth/osoba/person.${uco}"><img alt="x"></a>Faculty of Informatics<br>Student</div></div>`;

test("finds people by UČO even when their profile link uses a login, ignoring other results", () => {
  const html = `<main id="app_content"><div class="vyh_polozka " data-agenda="K"><h4><a href="/predmet/fi/X">A course</a></h4></div>${result(21)}</main>`;
  assert.deepEqual(parsePeopleSearch(html), {
    people: [{ uco: "21", name: "Mgr. Person 21", details: ["Faculty of Informatics", "Student"], profile: "https://is.muni.cz/auth/osoba/21" }],
    hasMore: false,
  });
});

test("says whether another page of results exists, without mistaking start=20 for start=2", () => {
  const pager = (...pages: number[]) => `<main id="app_content"><div class="strankovani">${pages.map((p) => `<a href="./?search=x;ag=os;start=${p}">${p}</a>`).join("")}</div></main>`;
  assert.equal(parsePeopleSearch(pager(2, 3), 1).hasMore, true);
  assert.equal(parsePeopleSearch(pager(1, 2), 2).hasMore, false);
  assert.equal(parsePeopleSearch(pager(1, 20), 1).hasMore, false);
});

test("encodes the search and filters to people", async () => {
  const requested: string[] = [];
  const session = {
    getPage: async (url: string | URL) => {
      requested.push(String(url));
      return { url: new URL(url), html: `<main id="app_content"></main>` };
    },
  };
  assert.deepEqual((await searchPeople(session, " Jan;akce=x ")).people, []);
  assert.equal(requested[0], "https://is.muni.cz/auth/vyhledavani/?search=Jan%3Bakce%3Dx;ag=os;start=1");
  await assert.rejects(searchPeople(session, "  "), /Enter a name/);
  await assert.rejects(fetchFriends(session), /no person counts/);
});

const confirmPage = (uco: number, confirmUco = uco) => `<main id="app_content"><h3>Chystáte se požádat o známost osobu</h3>
  <p class="clen_info"><b>Person ${uco}</b>, <span class="nedurazne">učo ${uco}</span></p>
  <p><a href="./lide_znami?mafr_ok=1;mafr=${confirmUco};x=aB3_-">ano, opravdu požádat</a> <a href="./lide_znami">ne, nežádat</a></p></main>`;

// Answers like IS: the list reflects the request only once the confirmation link has been opened.
function friendSession(options: { known?: string[]; sent?: string[]; extra?: string; ask?: string; confirmWorks?: boolean } = {}) {
  const requested: string[] = [];
  let confirmed = false;
  return {
    requested,
    getPage: async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("mafr_ok=")) confirmed = options.confirmWorks ?? true;
      const html = url.includes("?mafr=")
        ? (options.ask ?? confirmPage(21))
        : page(options.known ?? [], [...(options.sent ?? []), ...(confirmed ? [request(21)] : [])], options.extra);
      return { url: new URL(url), html };
    },
  };
}

test("sends a request through IS's confirmation link and checks it was recorded", async () => {
  const session = friendSession();
  assert.deepEqual(await sendFriendRequest(session, "21"), { status: "sent", uco: "21", name: "Person 21" });
  assert.deepEqual(session.requested.filter((url) => url.includes("mafr")), [
    "https://is.muni.cz/auth/lide/lide_znami?mafr=21",
    "https://is.muni.cz/auth/lide/lide_znami?mafr_ok=1;mafr=21;x=aB3_-",
  ]);
});

test("sends nothing to someone already connected", async () => {
  const already = friendSession({ known: [friend(21, "4. 11. 2026")] });
  assert.equal((await sendFriendRequest(already, "21")).status, "already-friends");
  const pending = friendSession({ sent: [request(21)] });
  assert.equal((await sendFriendRequest(pending, "21")).status, "already-requested");
  const waiting = friendSession({ extra: `<h3>Lidé, kteří požádali o to být Moji známí</h3><ul>${request(21)}</ul>` });
  await assert.rejects(sendFriendRequest(waiting, "21"), /already asked/);
  for (const session of [already, pending, waiting]) assert.ok(!session.requested.some((url) => url.includes("mafr")));
});

test("won't confirm if the page names or links to a different person", async () => {
  for (const ask of [confirmPage(99), confirmPage(21, 99), `<main id="app_content"><p>nothing here</p></main>`]) {
    const session = friendSession({ ask });
    await assert.rejects(sendFriendRequest(session, "21"), /nothing was sent/);
    assert.ok(!session.requested.some((url) => url.includes("mafr_ok")));
  }
});

test("passes on IS's reason when it refuses", () => {
  const refused = `<main id="app_content"><div class="zdurazneni info">Nemůžete navázat známost sám se sebou.</div></main>`;
  assert.throws(() => parseRequestConfirmation(refused, "21"), /refused the request: Nemůžete navázat/);
});

test("fails loudly if IS doesn't record the request", async () => {
  await assert.rejects(sendFriendRequest(friendSession({ confirmWorks: false }), "21"), /did not record/);
});

test("refuses a non-numeric UČO without requesting anything", async () => {
  const session = friendSession();
  await assert.rejects(sendFriendRequest(session, "21;cafr=1"), /uco must be/);
  assert.deepEqual(session.requested, []);
});
