import test from "node:test";
import assert from "node:assert/strict";
import { isPaidRouteAlias } from "../paths.js";

test("canonical paid paths and other routes pass", () => {
  for (const p of ["/bet", "/support", "/unlock", "/", "/tracks", "/health", "/logo.svg", "/bets", "/bet/x"]) {
    assert.equal(isPaidRouteAlias(p), false, p);
  }
});
test("loose spellings of paid routes are refused", () => {
  for (const p of ["/bet/", "//bet", "/BET", "/bet//", "/%62et", "/Support", "/support/", "/unlock/", "/%75nlock",
    "/bet%3F", "/bet%3Fx", "/BET%3f", "/bet/%3F", "//bet%23", "/%62et%23", "/support%3Famount=500", "/unlock%23zz"]) {
    assert.equal(isPaidRouteAlias(p), true, p);
  }
});
