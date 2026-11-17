import test from "node:test";
import assert from "node:assert/strict";
import { newsletterDraftPlaceholders, replaceCampaignLinks, unresolvedEmailPlaceholders } from "../server/email-content.mjs";

test("email placeholders are detected without treating markdown links as placeholders", () => {
  assert.deepEqual(unresolvedEmailPlaceholders("Hi [First name]", "Visit [LUMEN](https://visit-lumen.com)"), ["[First name]"]);
  assert.deepEqual(newsletterDraftPlaceholders({ closing: "[Sender name]\n[business contact details and physical mailing address]" }), ["[Sender name]", "[business contact details and physical mailing address]"]);
});

test("campaign links are replaced while policy citations remain intact", () => {
  const result = replaceCampaignLinks("Demo: https://lumen1.vercel.app/. Rules: https://mailchimp.com/help/about-your-contacts/", "visit-lumen.com");
  assert.equal(result.replaced, 1);
  assert.match(result.text, /https:\/\/visit-lumen\.com\//);
  assert.match(result.text, /https:\/\/mailchimp\.com\/help\/about-your-contacts\//);
});
