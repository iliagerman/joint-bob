import { chromium } from "playwright-core";

let installed = false;

export async function installStaticBrowserTransport() {
  if (installed) return;
  installed = true;

  const originalLaunch = chromium.launch;
  chromium.launch = async function (...args) {
    const browser = await originalLaunch.apply(this, args);
    const originalNewContext = browser.newContext;

    browser.newContext = async function (...contextArgs) {
      const context = await originalNewContext.apply(this, contextArgs);
      await context.route(
        (url) =>
          (url.protocol === "http:" || url.protocol === "https:") &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
          !url.pathname.startsWith("/api/") &&
          !url.pathname.startsWith("/ws"),
        async (route) => {
          const request = route.request();
          const resourceType = request.resourceType();
          const isStaticGet =
            request.method() === "GET" &&
            ["script", "stylesheet", "image", "font", "media", "manifest"].includes(resourceType);

          if (request.isNavigationRequest() || resourceType === "document" || !isStaticGet) {
            await route.fallback();
            return;
          }

          try {
            const response = await route.fetch({ maxRedirects: 0, maxRetries: 1 });
            await route.fulfill({ response });
          } catch (error) {
            const url = new URL(request.url());
            const requestUrl = `${url.origin}${url.pathname}`.slice(0, 300);
            const detail = String(error instanceof Error ? error.message : error).split(/\r?\n/, 1)[0].slice(0, 500);
            console.error(`[static-browser-transport] ${requestUrl}: ${detail}`);
            await route.abort("failed");
          }
        },
      );
      return context;
    };

    return browser;
  };
}
