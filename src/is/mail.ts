import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { load } from "cheerio";
import PostalMime, { type Address } from "postal-mime";
import { IS_ORIGIN, type IsSession } from "./session.js";
import { loadAppPage, text } from "./student.js";
import { parseMailDate } from "./time.js";

const MAIL_URL = `${IS_ORIGIN}/auth/mail/`;
// IS's own message size limit is far lower; this only keeps a surprise from filling memory.
const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_MAX_BODY_CHARS = 20_000;

/** A message's location in IS. Both ids go into URLs, so they have to be plain numbers. */
export type EmailRef = { folderId: string; messageId: string };

function numericId(value: string, what: string) {
  if (!/^\d+$/.test(value)) throw new Error(`${what} must be the number from list_emails.`);
  return value;
}

/** Parse a mail folder page: every folder with its counts, and all of this folder's messages. */
export function parseMailbox(html: string, now = new Date()) {
  const $ = loadAppPage(html, "IS MU mail");
  // Each folder has hidden inputs <id>_nazev (name), <id>_typ (INBOX, SENT…) and <id>_pocty ("unread/total").
  const folders = $("input[name$='_pocty']").toArray().map((input) => {
    const id = ($(input).attr("name") ?? "").replace(/_pocty$/, "");
    const [unread = 0, total = 0] = ($(input).attr("value") ?? "").split("/").map(Number);
    return {
      id,
      name: $(`input[name="${id}_nazev"]`).attr("value") ?? null,
      type: $(`input[name="${id}_typ"]`).attr("value") ?? null,
      unread,
      total,
    };
  });
  if (!folders.length) throw new Error("The IS MU mail page has no folder list; its layout may have changed.");

  const emails = $("tr[id^='mail_']").toArray().map((row) => {
    const cells = $(row).children("td");
    return {
      id: ($(row).attr("id") ?? "").replace(/^mail_/, ""),
      correspondent: text(cells.eq(3)) || null,
      correspondentAddress: $(row).find("td[id^='from_id_']").attr("data-from_adr") || null,
      subject: text($(row).find("a[id^='read_link_']")),
      date: parseMailDate(text(cells.eq(5)), now),
      size: text(cells.eq(6)),
      unread: /\briadok_new\b/.test($(row).attr("class") ?? ""),
      answered: $(row).find('[title="Odpovězeno/Přeposláno"]').length > 0,
    };
  });
  return { folders, emails };
}

/**
 * List one page of a folder, the inbox by default. IS always sends the whole folder and its pager only
 * hides rows in the browser, so paging happens here. `complete` is false if IS sent fewer than the folder holds.
 */
export async function fetchEmails(
  session: Pick<IsSession, "getPage">,
  options: { folderId?: string; page?: number; pageSize?: number } = {},
) {
  const { page = 1, pageSize = DEFAULT_PAGE_SIZE } = options;
  const folderId = options.folderId === undefined ? await findInboxId(session) : numericId(options.folderId, "folderId");
  const { html } = await session.getPage(`${MAIL_URL}?folder_id=${folderId};order_by=datum;desc=1;all=1`);
  const { folders, emails } = parseMailbox(html);
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) {
    throw new Error(`No mail folder ${folderId}. Folders: ${folders.map((f) => `${f.id} (${f.name})`).join(", ")}.`);
  }
  return {
    source: "is-mu" as const,
    folder,
    folders,
    page,
    pageSize,
    totalPages: Math.ceil(emails.length / pageSize),
    complete: emails.length === folder.total,
    emails: emails.slice((page - 1) * pageSize, page * pageSize),
  };
}

async function findInboxId(session: Pick<IsSession, "getPage">) {
  const { folders } = parseMailbox((await session.getPage(MAIL_URL)).html);
  const inbox = folders.find((f) => f.type === "INBOX");
  if (!inbox) throw new Error("IS MU mail has no inbox folder.");
  return inbox.id;
}

// Fetch and parse the original message, which is more reliable than IS's rendering of it.
async function fetchMessage(session: Pick<IsSession, "getFile">, { folderId, messageId }: EmailRef) {
  const folder = numericId(folderId, "folderId");
  const message = numericId(messageId, "messageId");
  const response = await session.getFile(`${MAIL_URL}download?slozka=${folder};select-mail=${message};download=1`);
  // An unknown id is not an HTTP error: IS answers 200 with its normal HTML page.
  if (!response.headers.get("content-type")?.startsWith("message/rfc822") || !response.body) {
    await response.body?.cancel();
    throw new Error(`No email ${messageId} in folder ${folderId}.`);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>)) {
    bytes += (chunk as Uint8Array).length;
    if (bytes > MAX_MESSAGE_BYTES) throw new Error("This email is larger than the 100 MB limit.");
    chunks.push(chunk as Uint8Array);
  }
  const raw = Buffer.concat(chunks);
  // IS sends mbox format: an envelope "From …" line comes before the real headers.
  const start = raw.subarray(0, 5).toString("latin1") === "From " ? raw.indexOf(0x0a) + 1 : 0;
  return PostalMime.parse(raw.subarray(start));
}

const mailboxes = (addresses: Address[] = []) =>
  addresses.flatMap((a) => (a.group ? a.group : [a])).map(({ name, address }) => ({ name: name || null, address }));

// For HTML-only messages: readable text that keeps where each link goes.
function htmlToText(html: string) {
  const $ = load(html);
  $("head, script, style").remove();
  $("a[href^='http']").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    if (text($(a)) !== href) $(a).append(` (${href})`);
  });
  $("br").replaceWith("\n");
  $("p, div, li, tr, h1, h2, h3, h4, h5, h6").append("\n");
  return $.root().text().split("\n").map((line) => line.replace(/\s+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Read one email in full: headers, body as text (cut at `maxBodyChars`), and its attachments. */
export async function fetchEmail(
  session: Pick<IsSession, "getFile">,
  ref: EmailRef,
  { maxBodyChars = DEFAULT_MAX_BODY_CHARS }: { maxBodyChars?: number } = {},
) {
  const email = await fetchMessage(session, ref);
  const body = email.text?.trim() ? email.text.trim() : htmlToText(email.html ?? "");
  return {
    source: "is-mu" as const,
    ...ref,
    subject: email.subject ?? null,
    from: mailboxes(email.from ? [email.from] : []),
    replyTo: mailboxes(email.replyTo),
    to: mailboxes(email.to),
    cc: mailboxes(email.cc),
    date: email.date ?? null,
    body: body.slice(0, maxBodyChars),
    bodyTruncated: body.length > maxBodyChars,
    bodyChars: body.length,
    attachments: email.attachments.map((attachment, index) => ({
      index,
      name: attachment.filename,
      mimeType: attachment.mimeType,
      size: Buffer.byteLength(contentBytes(attachment.content)),
      // Images embedded in the message's layout rather than sent as files.
      inline: attachment.related === true || attachment.disposition === "inline",
    })),
  };
}

function contentBytes(content: ArrayBuffer | Uint8Array | string) {
  return typeof content === "string" ? Buffer.from(content) : new Uint8Array(content);
}

// The name comes from whoever sent the email, so nothing in it may steer where the file lands.
function safeFileName(name: string | null, index: number) {
  const base = (name ?? "").split(/[/\\]/).pop()?.replace(/[\x00-\x1f\x7f]/g, "").replace(/^[.\s]+/, "").trim();
  return `${index}-${base?.slice(-100) || "attachment"}`;
}

/** Save one attachment to `<directory>/mail/<folder>/<message>/<index>-<name>`, replacing any earlier copy. */
export async function downloadEmailAttachment(
  session: Pick<IsSession, "getFile">,
  ref: EmailRef & { attachment: number },
  options: { directory: string },
) {
  const email = await fetchMessage(session, ref);
  const attachment = email.attachments[ref.attachment];
  if (!attachment) throw new Error(`Email ${ref.messageId} has ${email.attachments.length} attachment(s); no index ${ref.attachment}.`);
  const content = contentBytes(attachment.content);
  const savedTo = join(options.directory, "mail", ref.folderId, ref.messageId, safeFileName(attachment.filename, ref.attachment));
  const partial = `${dirname(savedTo)}/${randomUUID()}.part`;
  await mkdir(dirname(savedTo), { recursive: true, mode: 0o700 });
  try {
    await writeFile(partial, content, { mode: 0o600 });
    await rename(partial, savedTo);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return { ...ref, name: attachment.filename, savedTo, bytes: Buffer.byteLength(content), mimeType: attachment.mimeType };
}
