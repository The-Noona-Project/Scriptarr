import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const moonRoot = path.resolve(import.meta.dirname, "..");
const readMoonFile = (relativePath) => fs.readFileSync(path.join(moonRoot, relativePath), "utf8");

test("home art cards keep title copy as an independent title-page link", () => {
  const source = readMoonFile("apps/user-next/components/home/HomeArtCard.jsx");
  const css = readMoonFile("apps/user-next/app/globals.css");

  assert.match(source, /const artHref = resolveArtHref\(item, shelfKind\)/);
  assert.match(source, /const titleHref = resolveTitleHref\(item\)/);
  assert.match(source, /<Link href=\{artHref\} className="moon-home-art-card-art"/);
  assert.match(source, /<Link href=\{titleHref\} className="moon-home-art-card-copy"/);
  assert.match(source, /className="moon-home-art-card-title"/);
  assert.doesNotMatch(source, /className="moon-home-art-card-copy"[\s\S]{0,300}<Link href=\{titleHref\}>/);
  assert.doesNotMatch(source, /preventDefault/);

  assert.match(source, /readerTarget\?\.chapterId/);
  assert.match(source, /return buildReaderPath\(typeSlug, titleId, chapterId\)/);
  assert.match(css, /\.moon-home-art-card-art\s*\{[\s\S]*?z-index: 0;/);
  assert.match(css, /\.moon-home-art-card-shade\s*\{[\s\S]*?pointer-events: none;/);
  assert.match(css, /\.moon-home-art-card-copy\s*\{[\s\S]*?z-index: 2;[\s\S]*?pointer-events: auto;/);
});

test("card media layers cannot intercept title-page navigation", () => {
  const titleCard = readMoonFile("apps/user-next/components/TitleCard.jsx");
  const libraryRow = readMoonFile("apps/user-next/components/LibraryTitleRow.jsx");
  const css = `${readMoonFile("apps/user-next/app/globals.css")}\n${readMoonFile("apps/user-next/app/list-loading.css")}`;

  assert.match(titleCard, /<Link href=\{readerHref\} className="moon-title-card-media"/);
  assert.match(titleCard, /<Link href=\{titleHref\} className="moon-title-card-copy"/);
  assert.match(libraryRow, /<Link href=\{readerHref\} className="moon-library-title-cover"/);
  assert.match(libraryRow, /<Link href=\{titleHref\} className="moon-library-title-link"/);
  assert.doesNotMatch(`${titleCard}\n${libraryRow}`, /preventDefault/);

  assert.match(css, /\.moon-title-card-media\s*\{[\s\S]*?z-index: 0;/);
  assert.match(css, /\.moon-title-card-copy\s*\{[\s\S]*?z-index: 1;/);
  assert.match(css, /\.moon-title-card-media img,[\s\S]*?pointer-events: none;/);
  assert.match(css, /\.moon-library-title-cover img\s*\{[\s\S]*?pointer-events: none;/);
  assert.match(css, /\.moon-global-loading-overlay\s*\{[\s\S]*?pointer-events: none;/);
});
