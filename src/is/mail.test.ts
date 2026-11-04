import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { downloadEmailAttachment, fetchEmail, fetchEmails, parseMailbox } from "./mail.js";
import { parseMailDate } from "./time.js";

// Synthetic markup and messages follow the observed structure without storing real mail.
const now = new Date("2026-11-04T12:00:00+01:00");

const folderInputs = (id: string, name: string, type: string, counts: string) =>
  `<input type=hidden name="${id}_nazev" value="${name}"><input type=hidden name="${id}_typ" value="${type}"><input type=hidden name="${id}_pocty" value="${counts}">`;

const row = (id: number, { unread = false, answered = false, date = "Po 2. 11." } = {}) => `
  <tr id="mail_${id}" class="${unread ? "riadok_new" : "riadok"} mbgr1">
    <td><input type="checkbox" name="mark" id="mark_${id}"></td>
    <td id="from_id_${id}" data-from_adr="a${id}@example.org">${answered ? '<span title="Odpovězeno/Přeposláno">x</span>' : ""}</td>
    <td></td>
    <td><span id="span_from_uco_${id}"><a class="jmeno" href="/auth/osoba/1">Sender ${id}</a></span></td>
    <td><a id="read_link_${id}" href="/auth/mail/?show_mail=${id};folder_id=10">Subject ${id}</a></td>
    <td>${date}</td>
    <td>9,9 KB</td>
  </tr>`;

const mailPage = (rows: string) => `<main id="app_content">
  ${folderInputs("10", "Příchozí pošta", "INBOX", "1/3")}${folderInputs("20", "Odeslaná pošta", "SENT", "0/0")}
  <table><tbody id="mail_list">${rows}</tbody></table></main>`;

const fakeSession = (rows: string) => {
  const requested: string[] = [];
  return {
    requested,
    getPage: async (url: string | URL) => {
      requested.push(String(url));
      return { url: new URL(url), html: mailPage(rows) };
    },
  };
};

test("parses folders and message rows", () => {
  const { folders, emails } = parseMailbox(mailPage(row(1, { unread: true, date: "dnes 9:15" }) + row(2, { answered: true })), now);
  assert.deepEqual(folders[0], { id: "10", name: "Příchozí pošta", type: "INBOX", unread: 1, total: 3 });
  assert.deepEqual(emails[0], {
    id: "1",
    correspondent: "Sender 1",
    correspondentAddress: "a1@example.org",
    subject: "Subject 1",
    date: "2026-11-04T09:15+01:00",
    size: "9,9 KB",
    unread: true,
    answered: false,
  });
  assert.deepEqual([emails[1]?.date, emails[1]?.unread, emails[1]?.answered], ["2026-11-02", false, true]);
});

test("reports a changed page instead of an empty mailbox", () => {
  assert.throws(() => parseMailbox(`<main id="app_content"></main>`), /no folder list/);
  assert.throws(() => parseMailbox(`<form><input type="password"></form>`), /authenticated/);
});

test("pages through a folder that IS sends whole", async () => {
  const session = fakeSession(row(1) + row(2) + row(3));
  const second = await fetchEmails(session, { folderId: "10", page: 2, pageSize: 2 });
  assert.deepEqual(second.emails.map((e) => e.id), ["3"]);
  assert.deepEqual([second.totalPages, second.complete], [2, true]);
  assert.deepEqual((await fetchEmails(session, { folderId: "10", page: 3, pageSize: 2 })).emails, []);
});

test("defaults to the inbox and flags a folder IS sent only part of", async () => {
  const session = fakeSession(row(1));
  const result = await fetchEmails(session);
  assert.equal(result.folder.type, "INBOX");
  assert.match(session.requested.at(-1)!, /[?;]folder_id=10;/);
  assert.equal(result.complete, false);
});

test("rejects unknown folders, even though IS would show a page for them", async () => {
  await assert.rejects(fetchEmails(fakeSession(""), { folderId: "99" }), /No mail folder 99.*10 \(Příchozí pošta\)/);
});

test("reads list dates, including across the new year", () => {
  assert.equal(parseMailDate("včera 18:02", now), "2026-11-03T18:02+01:00");
  assert.equal(parseMailDate("včera 18:02", new Date("2027-01-01T12:00:00+01:00")), "2026-12-31T18:02+01:00");
  assert.equal(parseMailDate("St 30.  12.", new Date("2027-01-02T12:00:00+01:00")), "2026-12-30");
  assert.equal(parseMailDate("St 4.  11.", now), "2026-11-04");
  assert.equal(parseMailDate("12. 3. 2024", now), "2024-03-12");
  assert.equal(parseMailDate("soon", now), null);
});

const rawMessage = (attachmentName: string) => [
  "From sender@example.org Mon Nov  2 09:00:00 2026",
  "From: =?UTF-8?Q?P=C5=99=C3=ADklad?= <sender@example.org>",
  "To: Student <student@example.org>, Team: one@example.org, two@example.org;",
  "Subject: =?UTF-8?Q?P=C5=99edm=C4=9Bt?=",
  "Date: Mon, 2 Nov 2026 09:00:00 +0100",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello from the body",
  "--b",
  `Content-Type: application/pdf; name="${attachmentName}"`,
  `Content-Disposition: attachment; filename="${attachmentName}"`,
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("%PDF-1.4 test").toString("base64"),
  "--b--",
  "",
].join("\r\n");

const fileSession = (body: string, type = "message/rfc822") => {
  const requested: string[] = [];
  return {
    requested,
    getFile: async (url: string | URL) => {
      requested.push(String(url));
      return new Response(body, { headers: { "content-type": type } });
    },
  };
};

const ref = { folderId: "10", messageId: "5" };

test("reads a raw message: decoded headers, flattened groups, body and attachments", async () => {
  const session = fileSession(rawMessage("notes.pdf"));
  const email = await fetchEmail(session, ref);
  assert.equal(session.requested[0], "https://is.muni.cz/auth/mail/download?slozka=10;select-mail=5;download=1");
  assert.equal(email.subject, "Předmět");
  assert.deepEqual(email.from, [{ name: "Příklad", address: "sender@example.org" }]);
  assert.deepEqual(email.to.map((a) => a.address), ["student@example.org", "one@example.org", "two@example.org"]);
  assert.equal(email.date, "2026-11-02T08:00:00.000Z");
  assert.equal(email.body, "Hello from the body");
  assert.deepEqual(email.attachments, [{ index: 0, name: "notes.pdf", mimeType: "application/pdf", size: 13, inline: false }]);
});

test("turns HTML-only mail into text that keeps link targets, and cuts long bodies", async () => {
  const raw = [
    "From: a@example.org", "Content-Type: text/html; charset=utf-8", "",
    `<html><head><style>p{}</style></head><body><p>First</p><script>bad()</script><p>Go <a href="https://example.org/x">here</a><br>now</p></body></html>`,
  ].join("\r\n");
  const email = await fetchEmail(fileSession(raw), ref);
  assert.equal(email.body, "First\nGo here (https://example.org/x)\nnow");
  const cut = await fetchEmail(fileSession(raw), ref, { maxBodyChars: 5 });
  assert.deepEqual([cut.body, cut.bodyTruncated, cut.bodyChars], ["First", true, email.bodyChars]);
});

test("treats IS's HTML answer to an unknown message as not found", async () => {
  await assert.rejects(fetchEmail(fileSession("<html></html>", "text/html; charset=utf-8"), ref), /No email 5 in folder 10/);
});

test("refuses non-numeric ids without requesting anything", async () => {
  const session = fileSession(rawMessage("a.pdf"));
  await assert.rejects(fetchEmail(session, { folderId: "10", messageId: "5;akce=drop_message" }), /messageId/);
  await assert.rejects(fetchEmail(session, { folderId: "../x", messageId: "5" }), /folderId/);
  await assert.rejects(fetchEmails(fakeSession(""), { folderId: "10;akce=empty_trash" }), /folderId/);
  assert.deepEqual(session.requested, []);
});

test("saves an attachment inside the download folder, whatever the sender named it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "muni-mcp-test-"));
  t.after(() => rm(directory, { recursive: true }));
  const result = await downloadEmailAttachment(fileSession(rawMessage("notes.pdf")), { ...ref, attachment: 0 }, { directory });
  assert.equal(relative(directory, result.savedTo), "mail/10/5/0-notes.pdf");
  assert.equal(await readFile(result.savedTo, "utf8"), "%PDF-1.4 test");
  assert.equal(result.bytes, 13);

  for (const hostile of ["../../../../evil.sh", "..\\..\\evil.sh", "..", "/etc/passwd"]) {
    const saved = await downloadEmailAttachment(fileSession(rawMessage(hostile)), { ...ref, attachment: 0 }, { directory });
    const location = relative(join(directory, "mail/10/5"), saved.savedTo);
    assert.match(location, /^0-[^/\\]*$/, hostile);
  }
  assert.ok(!(await readdir(join(directory, "mail/10/5"))).some((name) => name.endsWith(".part")));
});

test("names a missing attachment index", async () => {
  await assert.rejects(
    downloadEmailAttachment(fileSession(rawMessage("a.pdf")), { ...ref, attachment: 3 }, { directory: "/nonexistent" }),
    /has 1 attachment\(s\); no index 3/,
  );
});
