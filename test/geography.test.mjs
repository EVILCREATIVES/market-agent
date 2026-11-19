import test from "node:test";
import assert from "node:assert/strict";

import { newsletterGeography } from "../server/newsletters.mjs";

test("newsletter geography aggregates the same region across sent campaigns", () => {
  const report = newsletterGeography([
    { locations: [{ countryCode: "US", country: "United States", region: "New York", city: "", value: 4, secondaryValue: 5, conversions: 0 }] },
    { locations: [{ countryCode: "US", country: "United States", region: "New York", city: "", value: 3, secondaryValue: 4, conversions: 0 }] },
    { locations: [{ countryCode: "GB", country: "United Kingdom", region: "England", city: "", value: 2, secondaryValue: 2, conversions: 0 }] },
  ]);
  assert.equal(report.availability, "live");
  assert.equal(report.locations[0].countryCode, "US");
  assert.equal(report.locations[0].value, 7);
  assert.equal(report.locations[0].secondaryValue, 9);
});

test("newsletter geography remains honest when no delivery location is reported", () => {
  const report = newsletterGeography([{ locations: [] }]);
  assert.equal(report.availability, "insufficient_data");
  assert.deepEqual(report.locations, []);
});
