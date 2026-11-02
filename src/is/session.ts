import { setTimeout as sleep } from "node:timers/promises";
import { load } from "cheerio";
import makeFetchCookie from "fetch-cookie";

export const IS_ORIGIN = "https://is.muni.cz";
const LOGIN_ORIGIN = "https://muni.islogin.cz";
const allowedOrigins = new Set([IS_ORIGIN, LOGIN_ORIGIN]);

export type Credentials = { username: string; password: string };
type Page = { url: URL; html: string };

const MAX_CONCURRENT = 4;
const RETRIES = 2;
const PAGE_TIMEOUT_MS = 30_000;
// Covers reading the whole body, so it has to allow for large files on a slow connection.
const FILE_TIMEOUT_MS = 10 * 60_000;
// IS occasionally drops keep-alive sockets or briefly refuses a request; both succeed on retry.
const retryableStatus = new Set([409, 502, 503, 504]);

function hasPasswordField(html: string) {
  return load(html)('input[type="password"]').length > 0;
}

/**
 * An authenticated, read-only IS MU reader. Cookies live in memory only.
 * It logs in lazily on the first request and again whenever IS redirects to the login form
 * (e.g. after the session expires). The only POST it ever sends is the login form.
 */
export function createIsSession(credentials: Credentials) {
  const cookieFetch = makeFetchCookie(fetch);
  let active = 0;
  const waiting: (() => void)[] = [];

  // One HTTP exchange: at most MAX_CONCURRENT at a time; GETs retry on network errors and
  // retryable statuses. The login POST is never retried.
  async function send(url: URL, form?: URLSearchParams, timeoutMs = PAGE_TIMEOUT_MS) {
    while (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      for (let attempt = 0; ; attempt++) {
        const canRetry = !form && attempt < RETRIES;
        try {
          const response = await cookieFetch(url, {
            method: form ? "POST" : "GET",
            body: form,
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!canRetry || !retryableStatus.has(response.status)) return response;
          await response.body?.cancel();
        } catch (error) {
          // fetch reports network failures as TypeError; timeouts and other errors are final.
          if (!canRetry || !(error instanceof TypeError)) throw error;
        }
        await sleep(500 * (attempt + 1));
      }
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  // Follow redirects manually so every hop stays on the two known HTTPS origins.
  async function open(url: URL, body?: URLSearchParams, timeoutMs?: number) {
    let current = url;
    let form = body;
    for (let redirects = 0; redirects <= 12; redirects++) {
      if (!allowedOrigins.has(current.origin)) {
        throw new Error("IS MU redirected to an unexpected origin.");
      }
      const response = await send(current, form, timeoutMs);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("A redirect did not provide a destination.");
        const next = new URL(location, current);
        if ([301, 302, 303].includes(response.status)) form = undefined;
        if (form && next.origin !== current.origin) {
          throw new Error("Refusing to forward login credentials across origins.");
        }
        await response.body?.cancel();
        current = next;
        continue;
      }
      if (!response.ok) throw new Error(`IS MU request failed: HTTP ${response.status}.`);
      return { url: current, response };
    }
    throw new Error("IS MU exceeded the redirect limit.");
  }

  async function request(url: URL, body?: URLSearchParams): Promise<Page> {
    const { url: finalUrl, response } = await open(url, body);
    return { url: finalUrl, html: await response.text() };
  }

  // Submit the observed muni.islogin.cz form: hidden fields + credential_0 (UČO) + credential_1 (password).
  async function submitLogin(loginPage: Page): Promise<Page> {
    const $ = load(loginPage.html);
    const form = $('input[type="password"]').closest("form");
    if (form.length !== 1 || loginPage.url.origin !== LOGIN_ORIGIN) {
      throw new Error("The expected IS MU login form was not found.");
    }
    const action = new URL(form.attr("action") || loginPage.url.href, loginPage.url);
    if (action.origin !== LOGIN_ORIGIN || form.attr("method")?.toLowerCase() !== "post") {
      throw new Error("The login form has an unexpected submission target.");
    }
    if (!form.find('[name="credential_0"]').length || !form.find('[name="credential_1"]').length) {
      throw new Error("The IS MU login form fields have changed.");
    }
    const payload = new URLSearchParams();
    form.find('input[type="hidden"][name]').each((_, element) => {
      const name = $(element).attr("name");
      if (name) payload.append(name, $(element).val()?.toString() ?? "");
    });
    const submit = form.find('button[type="submit"][name]').first();
    const submitName = submit.attr("name");
    if (submitName) payload.set(submitName, submit.val()?.toString() ?? "");
    payload.set("credential_0", credentials.username);
    payload.set("credential_1", credentials.password);
    return request(action, payload);
  }

  function isTarget(input: string | URL) {
    const target = new URL(input, IS_ORIGIN);
    if (target.origin !== IS_ORIGIN) throw new Error("Only IS MU pages can be requested.");
    // IS changes state through plain GET links: exam (un)registration and actions like favourites.
    if (/(?:^|[?;&])(?:prihlasit|odhlasit|operace)=/i.test(target.search)) {
      throw new Error("Refusing to request an IS MU URL that changes data.");
    }
    return target;
  }

  /** GET an authenticated IS MU page, logging in first when needed. */
  async function getPage(input: string | URL): Promise<Page> {
    const target = isTarget(input);
    let page = await request(target);
    if (page.url.origin === LOGIN_ORIGIN) {
      page = await submitLogin(page);
      // IS normally returns to the requested page; fetch it explicitly if it did not.
      if (page.url.origin === IS_ORIGIN && page.url.pathname !== target.pathname) {
        page = await request(target);
      }
    }
    if (page.url.origin !== IS_ORIGIN || hasPasswordField(page.html)) {
      throw new Error("IS MU login failed. Check credentials; MFA or another login step may be required.");
    }
    return page;
  }

  /** GET an authenticated IS MU file as an unread `Response`, so callers can stream its body. */
  async function getFile(input: string | URL) {
    const target = isTarget(input);
    // Logging in returns to the requested URL as text, which would buffer the whole file,
    // so make sure the session is live using a small page first.
    await getPage("/auth/student/");
    const { url, response } = await open(target, undefined, FILE_TIMEOUT_MS);
    if (url.origin !== IS_ORIGIN) {
      await response.body?.cancel();
      throw new Error("The IS MU session expired during the download. Try again.");
    }
    return response;
  }

  return { getPage, getFile };
}

export type IsSession = ReturnType<typeof createIsSession>;
