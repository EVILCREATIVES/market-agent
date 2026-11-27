import assert from "node:assert/strict";
import test from "node:test";
import sections from "../src/operational/brand-builder-sections.json" with { type: "json" };
import { brandChaptersAfterEdit, emptyBrandBuild, isBrandMethodOwner, normalizeBrandSystem, normalizeBrandTheme } from "../server/brand-builder.mjs";
import { approvedBrandInstructions, projectBrandProjection, relevantBrandLessons, repeatedBrandFeedback } from "../server/brand-canon.mjs";

const theme = { paper: "#f6f1e3", ink: "#172222", accent: "#ad4228", layout: "editorial", typeStyle: "serif", direction: "Use one repeating shape each season." };
const faces = ["both", "neither", "first", "second", "first-contradiction", "second-contradiction"];
const preview = { headline: "Your morning, considered.", copy: "The house blend is available every day.", action: "See the blends", imagery: "Morning light on the same table." };

function fixture() {
  return {
    name: "Fable Coffee",
    idea: "A daily ritual with a seasonal variation",
    theme,
    sections: sections.map(({ id }) => ({ id, text: `Working chapter for ${id}`, example: `Example for ${id}`, sourceIds: ["source-1", "made-up"] })),
    faces: faces.map((face) => ({ face, story: `A story on ${face}`, boundary: "Honor what the customer can expect.", preview })),
    words: faces.map((face, index) => ({
      id: `word-${index}`, face, word: `Word ${index}`, meaning: "Invites one new sensation", application: "Shift the expression on a seasonal pack.",
      links: [{ id: `word-${(index + 1) % faces.length}`, reason: "The second term modifies the scene." }, { id: "unknown", reason: "Invalid target" }],
    })),
    guidelines: { logo: "Use the current mark.", palette: "Reserve red for seasonal releases.", type: "Set headings in a serif.", imagery: "Use morning light.", layout: "Keep generous margins.", motion: "Use a slow reveal.", avoid: "Avoid automatic embellishments." },
    checks: ["Is the central ritual recognizable?", "Does the variation create a sensory change?", "Is the featured blend available?"],
  };
}

test("the Bible keeps all 19 sections, six related vocabulary faces, and user corrections", () => {
  const raw = fixture();
  const correction = { text: "Teach a repeatable way to brew.", example: "Use a consistent pour timing." };
  const draft = {
    ...emptyBrandBuild().draft,
    discovery: { brandName: raw.name, sources: [{ id: "source-1" }] },
    corrections: { idea: correction },
  };
  const result = normalizeBrandSystem(raw, draft, { theme });
  assert.equal(result.sections.length, 19);
  assert.equal(result.faces.length, 6);
  assert.equal(result.idea, correction.text);
  assert.equal(result.sections.find(({ id }) => id === "idea").example, correction.example);
  assert.deepEqual(result.sections[0].sourceIds, ["source-1"]);
  assert.equal(result.words[0].links.length, 1);
  assert.equal(result.words[0].links[0].id, result.words[1].id);
  assert.throws(() => normalizeBrandSystem({ ...raw, faces: raw.faces.slice(0, 5) }, draft, { theme }), { statusCode: 502 });
  assert.deepEqual(new Set(brandChaptersAfterEdit(["Strategy", "Identity", "Practice"], "visual")), new Set(["Strategy"]));
});

test("approved focus and remembered examples resolve by context and version", () => {
  const system = fixture();
  const approved = { version: 2, system, axis: { first: "Ritual", second: "Spontaneity" } };
  const focus = [
    { context: "Homepage", face: "first", reason: "A dependable first cup", version: 2 },
    { context: "Limited release", face: "second", reason: "Lead with the new origin", version: 2 },
    { context: "Limited release homepage", face: "both", reason: "Show the blend and the twist", version: 2 },
    { context: "Default", face: "first", reason: "Default creative direction", version: 2 },
    { context: "Newsletter", face: "second", reason: "A superseded decision", version: 1 },
  ];
  const memory = [
    { section: "voice", context: "Homepage", verdict: "avoid", example: "Make every morning extraordinary", reason: "An interchangeable claim" },
    { section: "voice", context: "Limited release", verdict: "keep", example: "A fresh variation", reason: "Tied to the actual release" },
  ];
  const workspace = { creativeBrand: projectBrandProjection(approved, focus, memory) };
  const home = approvedBrandInstructions(workspace, "A new homepage.");
  assert.match(home, /A dependable first cup/);
  assert.match(home, /An interchangeable claim/);
  assert.doesNotMatch(home, /A fresh variation/);
  const release = approvedBrandInstructions(workspace, "Rework the limited release homepage");
  assert.match(release, /Show the blend and the twist/);
  assert.match(release, /A fresh variation/);
  assert.doesNotMatch(approvedBrandInstructions(workspace, "Newsletter"), /A superseded decision/);
  assert.deepEqual(repeatedBrandFeedback(relevantBrandLessons(memory, { context: "Homepage" }), [
    { section: "voice", text: "MAKE EVERY MORNING EXTRAORDINARY!" },
  ]), [memory[0]]);
  assert.deepEqual(repeatedBrandFeedback(relevantBrandLessons(memory, { context: "Newsletter" }), [
    { section: "voice", text: "MAKE EVERY MORNING EXTRAORDINARY!" },
  ]), []);
});

test("brand theme protects text contrast and global methods belong to the configured owner", () => {
  assert.equal(normalizeBrandTheme({ paper: "#1b1d1a", ink: "#1b1d1a" }, theme).ink, "#ffffff");
  assert.equal(normalizeBrandTheme({ accent: "url(http://example.com)" }, theme).accent, theme.accent);
  assert.equal(isBrandMethodOwner("OWNER@example.com", { OWNER_EMAIL: "owner@example.com" }), true);
  assert.equal(isBrandMethodOwner("not-owner@example.com", { OWNER_EMAIL: "owner@example.com" }), false);
});
