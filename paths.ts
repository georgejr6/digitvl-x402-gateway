// The x402 middleware matches routes loosely (decodes %xx, collapses "//",
// drops a trailing "/", ignores case), but Hono's app.use("/bet") pre-gates
// only match the exact path. So "/bet/", "//bet" or "/BET" reach the
// facilitator WITHOUT the /bet pre-checks (a bare axfer to the pool app
// verifies fine there). Today the strict Hono handlers 404 those and nothing
// settles; refuse them up front so it never depends on that.
const PAID_ROUTES = new Set(["/bet", "/support", "/unlock"]);

export function looseRouteKey(pathname: string): string {
  const decoded = pathname
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/")
    // x402 cuts its fully-decoded path at "?"/"#", so "/bet%3Fx" is /bet there.
    .split(/[?#]/)[0];
  return decoded.replace(/\/+/g, "/").replace(/(.+?)\/+$/, "$1").toLowerCase();
}

// True when `pathname` is a non-canonical spelling of a paid route.
export function isPaidRouteAlias(pathname: string): boolean {
  return pathname !== looseRouteKey(pathname) && PAID_ROUTES.has(looseRouteKey(pathname));
}
