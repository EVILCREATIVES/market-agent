import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeSvgMarkup, isSvgAsset, svgMarkupSafetyError } from "../server/svg-safety.mjs";

const validSvg = `<?xml version="1.0"?>
<!-- exported artwork -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><linearGradient id="paint"><stop stop-color="#fff"/></linearGradient></defs>
  <rect width="100" height="100" fill="url(#paint)"/>
  <image href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/>
</svg>`;

test("ordinary self-contained SVG artwork is accepted", () => {
  assert.equal(svgMarkupSafetyError(validSvg), "");
  assert.doesNotThrow(() => assertSafeSvgMarkup(validSvg));
  assert.equal(isSvgAsset("brand-mark.svg", ""), true);
  assert.equal(isSvgAsset("brand-mark", "image/svg+xml; charset=utf-8"), true);
});

test("active SVG content and remote resources are rejected", () => {
  const unsafe = [
    `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>HTML</div></foreignObject></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/pixel.png"/></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><style>@import 'https://tracker.example/style.css';</style></svg>`,
    `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"/>`,
  ];
  for (const markup of unsafe) assert.notEqual(svgMarkupSafetyError(markup), "", markup);
});

test("non-SVG files are not treated as SVG", () => {
  assert.equal(isSvgAsset("photo.png", "image/png"), false);
  assert.match(svgMarkupSafetyError(`<html></html>`), /not a valid standalone SVG/i);
});
