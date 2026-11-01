import { load } from "cheerio";
import makeFetchCookie from "fetch-cookie";

export const IS_ORIGIN = "https://is.muni.cz";
const LOGIN_ORIGIN = "https://muni.islogin.cz";
const allowedOrigins = new Set([IS_ORIGIN, LOGIN_ORIGIN]);

export type Credentials = { username: string; password: string };
type Page = { url: URL; html: string };

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

  // Follow redirects manually so every hop stays on the two known HTTPS origins.
  async function request(url: URL, body?: URLSearchParams): Promise<Page> {
    let current = url;
    let form = body;
    for (let redirects = 0; redirects <= 12; redirects++) {
      if (!allowedOrigins.has(current.origin)) {
        throw new Error("IS MU redirected to an unexpected origin.");
      }
      const response = await cookieFetch(current, {
        method: form ? "POST" : "GET",
        body: form,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
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
      return { url: current, html: await response.text() };
    }
    throw new Error("IS MU exceeded the redirect limit.");
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

  return {
    /** GET an authenticated IS MU page, logging in first when needed. */
    async getPage(input: string | URL): Promise<Page> {
      const target = new URL(input, IS_ORIGIN);
      if (target.origin !== IS_ORIGIN) throw new Error("Only IS MU pages can be requested.");
      // IS registers/unregisters exam terms through plain GET links carrying these flags.
      if (/(?:^|[?;&])(?:prihlasit|odhlasit)=/i.test(target.search)) {
        throw new Error("Refusing to request an IS MU URL that changes registrations.");
      }
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
    },
  };
}

export type IsSession = ReturnType<typeof createIsSession>;
