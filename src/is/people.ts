import { IS_ORIGIN, type IsSession } from "./session.js";
import { loadAppPage, text } from "./student.js";
import { parseIsDate } from "./time.js";

const FRIENDS_URL = `${IS_ORIGIN}/auth/lide/lide_znami`;
const profileUrl = (uco: string) => `${IS_ORIGIN}/auth/osoba/${uco}`;

/** Parse the Moji známí page: your friends, the requests you sent, and requests sent to you. */
export function parseFriends(html: string) {
  const $ = loadAppPage(html, "Moji známí");
  const app = $("#app_content");
  // "Seznam osob (34 známých + 15 požádaných)": IS's own counts, used to catch a changed layout.
  const counts = /\((\d+)\s+znám\S*\s*\+\s*(\d+)\s+požádan/.exec(text(app.find("#edit_nav")));
  if (!counts) throw new Error("The Moji známí page has no person counts; its layout may have changed.");

  // Each section is an <h3> followed by its rows: div.clen_info for friends, li for requests.
  const section = (heading: RegExp) =>
    app.find("h3").filter((_, h) => heading.test(text($(h)))).first().nextUntil("h3").find(".clen_info, li").toArray().map((element) => {
      const row = $(element);
      const uco = /\d+/.exec(text(row.find(".nedurazne").first()))?.[0] ?? "";
      const email = /[?;&]to=([^;&]*)/.exec(row.find("a[href*='mail_posli']").attr("href") ?? "")?.[1];
      const lastSeen = /naposledy v IS:\s*([\d.\s:]+)/.exec(text(row))?.[1];
      return {
        uco,
        name: text(row.find("b").first()),
        email: email ? decodeURIComponent(email) : null,
        lastSeen: lastSeen ? parseIsDate(lastSeen) : null,
        profile: profileUrl(uco),
      };
    });

  const friends = section(/^Moji známí/);
  const requestsSent = section(/požádáni/);
  if (friends.length !== Number(counts[1]) || requestsSent.length !== Number(counts[2])) {
    throw new Error("The Moji známí lists don't match IS's counts; the page's layout may have changed.");
  }
  // IS's help names this section "Lidé, kteří požádali…"; it only appears while someone is waiting.
  return { friends, requestsSent, requestsReceived: section(/požádali/) };
}

/**
 * Read IS's "really send?" page for one person and return its confirmation URL. Checks the page names
 * the same UČO that was asked for, so a changed page can't send the request to someone else.
 */
export function parseRequestConfirmation(html: string, uco: string) {
  const $ = loadAppPage(html, "friend request");
  const app = $("#app_content");
  const link = app.find("a").filter((_, a) => text($(a)) === "ano, opravdu požádat").first();
  const pageUco = /\d+/.exec(text(app.find(".clen_info .nedurazne").first()))?.[0];
  const href = link.attr("href") ?? "";
  const expected = new RegExp(`^\\./lide_znami\\?mafr_ok=1;mafr=${uco};x=[\\w-]+$`);
  if (pageUco !== uco || !expected.test(href)) {
    // IS explains refusals, such as asking yourself, in a note on its normal list page.
    const note = text(app.find(".zdurazneni").first());
    throw new Error(note ? `IS MU refused the request: ${note}` : "The friend request page was not as expected, so nothing was sent.");
  }
  return { name: text(app.find(".clen_info b").first()), url: new URL(href, FRIENDS_URL) };
}

/** Parse one page of IS search results. Other result types, such as courses, are ignored. */
export function parsePeopleSearch(html: string, page = 1) {
  const $ = loadAppPage(html, "IS MU search");
  $("#app_content .vyh_hlavicky br").replaceWith("\n");
  const people = $("#app_content .vyh_polozka.lide").toArray().flatMap((element) => {
    const row = $(element);
    const uco = /\(učo\s*(\d+)\)/i.exec(text(row))?.[1];
    if (!uco) return [];
    const details = row.find(".vyh_hlavicky").first().text().split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
    return [{ uco, name: text(row.find("h4 a").first()), details, profile: profileUrl(uco) }];
  });
  // The pager links to pages by number: `start=2`, `start=3`…
  const nextPage = new RegExp(`[?;&]start=${page + 1}(?:$|[;&])`);
  const hasMore = $("#app_content .strankovani a").toArray().some((a) => nextPage.test($(a).attr("href") ?? ""));
  return { people, hasMore };
}

export async function fetchFriends(session: Pick<IsSession, "getPage">) {
  const { html } = await session.getPage(FRIENDS_URL);
  return { source: "is-mu" as const, ...parseFriends(html) };
}

/** Search people by name or UČO through IS's own search, limited to its people category. IS shows 10 per page. */
export async function searchPeople(session: Pick<IsSession, "getPage">, query: string, page = 1) {
  const search = query.trim();
  if (!search) throw new Error("Enter a name or UČO to search for.");
  const { html } = await session.getPage(`${IS_ORIGIN}/auth/vyhledavani/?search=${encodeURIComponent(search)};ag=os;start=${page}`);
  return { source: "is-mu" as const, query: search, page, ...parsePeopleSearch(html, page) };
}

/**
 * Send a friend request, which makes IS email the person. Does nothing if you're already connected,
 * and checks afterwards that IS recorded the request.
 */
export async function sendFriendRequest(session: Pick<IsSession, "getPage">, uco: string) {
  if (!/^\d+$/.test(uco)) throw new Error("uco must be the person's number from search_people.");
  const before = await fetchFriends(session);
  const existing = (list: { uco: string; name: string }[]) => list.find((person) => person.uco === uco);
  const friend = existing(before.friends);
  if (friend) return { status: "already-friends" as const, uco, name: friend.name };
  const sent = existing(before.requestsSent);
  if (sent) return { status: "already-requested" as const, uco, name: sent.name };
  const received = existing(before.requestsReceived);
  if (received) throw new Error(`${received.name} already asked to be your friend. Answer that request in IS MU instead.`);

  const { name, url } = parseRequestConfirmation((await session.getPage(`${FRIENDS_URL}?mafr=${uco}`)).html, uco);
  await session.getPage(url);
  const after = await fetchFriends(session);
  if (!existing(after.requestsSent) && !existing(after.friends)) throw new Error(`IS MU did not record the request to ${name}.`);
  return { status: "sent" as const, uco, name };
}
