import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("the English review feature is absent while format and diagnosis configuration remains", async () => {
  const [indexHtml, appJs, serverJs] = await Promise.all([
    fs.readFile(path.join(process.cwd(), "public", "index.html"), "utf8"),
    fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8"),
    fs.readFile(path.join(process.cwd(), "server.js"), "utf8")
  ]);

  assert.doesNotMatch(indexHtml, /data-mode="review"|id="reviewView"|id="runReviewButton"|testReviewButton/);
  assert.doesNotMatch(appJs, /\/api\/review|runReview|loadReview|renderReview/);
  assert.doesNotMatch(serverJs, /app\.(?:get|post)\("\/api\/review/);
  assert.match(indexHtml, /data-provider="format"/);
  assert.match(serverJs, /provider:\s*config\.format/);
});
