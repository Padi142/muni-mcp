import assert from "node:assert/strict";
import test from "node:test";
import { fetchStudyCheck, parseStudyCheck, parseTemplates } from "./study-check.js";

// Synthetic markup follows the observed structure without storing student HTML.
const indent = (depth: number) => `<TT>${"&nbsp;&nbsp;".repeat(depth)}</TT>`;
const marks = {
  met: `<FONT COLOR=green><B>o</B></FONT>`,
  unmet: `<FONT COLOR=red><B>x</B></FONT>`,
  other: `<FONT COLOR=blue><B>o</B></FONT>`,
  enrolled: `<span class="maybe"><B>?</B></span>`,
};
const block = (depth: number, mark: keyof typeof marks, name: string, rule: string) =>
  `${indent(depth)}${marks[mark]}&nbsp;<b>${name}</b>&nbsp;&nbsp;–&nbsp; ${rule}<BR>\n`;
const course = (depth: number, mark: keyof typeof marks, code: string, after: string) =>
  `${indent(depth)}${marks[mark]}&nbsp;<b><a href="/auth/predmet/fi/jaro2027/${code}" class="okno">${code}</a></b>&nbsp; Course ${code}${after}<BR>\n`;

const form = (body: string) => `<main id="app_content"><form method="post" action="/auth/student/moje_kontrola_studia?fakulta=1;studium=2">
  <B>Povinné</B> šablony zadané u studia:<BR><INPUT TYPE=hidden NAME="exppar_sabprokon" VALUE="2"><label><INPUT TYPE=checkbox NAME="sabprokon_p" VALUE="30" CHECKED> FI:KŠ/X Template - 2026/2027</label><br />
  <B>Doplňkové</B> šablony zadané u studia:<BR><INPUT TYPE=hidden NAME="exppar_sabprokon" VALUE="2"><label><INPUT TYPE=checkbox NAME="sabprokon_d" VALUE="31"> FI:KŠ/Y Extra</label><br />
  <INPUT TYPE=submit NAME="sabprokon_tl" VALUE="Zkontrolovat studium"><HR>
  <TABLE><TR><TD>Zeleně (<B><FONT COLOR=GREEN>o</FONT></B>) … Otazník (<span class="maybe"><B>?</B></span>) …</TD></TR></TABLE><P>
  ${body}<P><HR></form></main>`;

const result = form(
  block(0, "unmet", "Template - 2026/2027", "vše") +
    block(1, "unmet", "Povinné předměty", "všech 3") +
    course(2, "enrolled", "XA001", ` <I><span class="maybe">zk (4 kr.)</span></I> [ pož. ukončení: zk ]`) +
    course(2, "unmet", "XA002", ` [ pož. ukončení: z, kredity: 16 ]`) +
    block(2, "unmet", "Volba", "alespoň 1 z 2") +
    course(3, "met", "XA003", ` <I><span style="color: green;">k (2 kr.)</span></I>`) +
    course(3, "other", "XA004", "") +
    block(1, "met", "Jazyk", "alespoň 2 kr."),
);

test("nests blocks and courses by their indentation", () => {
  const [root] = parseStudyCheck(result);
  assert.ok(root?.type === "block");
  assert.deepEqual([root.name, root.status, root.rule], ["Template - 2026/2027", "unmet", "vše"]);
  assert.deepEqual(root.items.map((item) => item.type === "block" && [item.name, item.rule, item.items.length]), [
    ["Povinné předměty", "všech 3", 3],
    ["Jazyk", "alespoň 2 kr.", 0],
  ]);
  const required = root.items[0]?.type === "block" ? root.items[0].items : [];
  assert.deepEqual(required[0], {
    type: "course", code: "XA001", name: "Course XA001", status: "enrolled", result: { completion: "zk", credits: 4 },
    requiredCompletion: "zk", requiredCredits: null, url: "https://is.muni.cz/auth/predmet/fi/jaro2027/XA001",
  });
  assert.deepEqual(required[1] && [required[1].status, "requiredCredits" in required[1] && required[1].requiredCredits], ["unmet", 16]);
  const choice = required[2]?.type === "block" ? required[2].items : [];
  assert.deepEqual(choice.map((c) => c.type === "course" && [c.code, c.status, c.result]), [
    ["XA003", "met", { completion: "k", credits: 2 }],
    ["XA004", "met-in-other-study", null],
  ]);
});

test("reports a changed page instead of an empty check", () => {
  assert.throws(() => parseStudyCheck(form("")), /no check results/);
  assert.throws(() => parseStudyCheck(form(block(2, "unmet", "Orphan", "vše"))), /bad indentation/);
  assert.throws(() => parseStudyCheck(form(`${indent(0)}<FONT COLOR=purple><B>x</B></FONT> <b>A</b><BR>`)), /unknown row marker/);
});

test("checks the current study against all its templates", async () => {
  const requested: string[] = [];
  const session = {
    getPage: async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      const html = url.endsWith("/auth/student/")
        ? `<main id="app_content"><form role="search"><input name="fakulta" value="1"><input name="obdobi" value="9"><input name="studium" value="2"></form></main>`
        : url.includes("sabprokon_tl") ? result : form("");
      return { url: new URL(url), html };
    },
  };
  const check = await fetchStudyCheck(session);
  assert.deepEqual(check.templates, [
    { id: "30", name: "FI:KŠ/X Template - 2026/2027", mandatory: true },
    { id: "31", name: "FI:KŠ/Y Extra", mandatory: false },
  ]);
  assert.equal(check.requirements.length, 1);
  assert.equal(requested[2], "https://is.muni.cz/auth/student/moje_kontrola_studia?fakulta=1;studium=2;exppar_sabprokon=2;sabprokon_p=30;sabprokon_d=31;sabprokon_tl=Zkontrolovat%20studium");
});

test("rejects template fields it would have to pass on blindly", () => {
  const html = form("").replace('VALUE="31"', 'VALUE="31;akce=x"');
  assert.throws(() => parseTemplates(html), /unexpected template fields/);
});
