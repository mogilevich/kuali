import test from "node:test";
import assert from "node:assert/strict";

import { ENGLISH_TRANSLATIONS } from "./i18n.js";
import { RUSSIAN_TRANSLATIONS } from "./i18n-ru.js";

// The fork ships every merged feature in Russian, so a new string must be
// translated before an integration build.
test("the fork build translates every English string into Russian", () => {
  assert.deepEqual(Object.keys(RUSSIAN_TRANSLATIONS).sort(), Object.keys(ENGLISH_TRANSLATIONS).sort());
});
