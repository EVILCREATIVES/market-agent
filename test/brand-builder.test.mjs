import assert from "node:assert/strict";
import test from "node:test";
import sections from "../src/operational/brand-builder-sections.json" with { type: "json" };
import relationships from "../src/operational/brand-relationships.json" with { type: "json" };
import { brandChaptersAfterEdit, emptyBrandBuild, isBrandMethodOwner, normalizeBrandFoundation, normalizeBrandSystem, normalizeBrandTheme, normalizeGuidedDraft, nextBrandQuestion } from "../server/brand-builder.mjs";
import { approvedBrandInstructions, projectBrandProjection, relevantBrandLessons, repeatedBrandFeedback } from "../server/brand-canon.mjs";
import { readBrandBuilderSources } from "../server/agent.mjs";

const theme = { paper: "#f6f1e3", ink: "#172222", accent: "#ad4228", layout: "editorial", typeStyle: "serif", direction: "Use one repeating shape each season." };
const faces = ["both", "neither", "first", "second", "first-contradiction", "second-contradiction"];
const preview = { headline: "Your morning, considered.", copy: "The house blend is available every day.", action: "See the blends", imagery: "Morning light on the same table." };

function fixture() {
  return {
    name: "Fable Coffee",
    idea: "A daily ritual with a seasonal variation",
    theme,
    sections: sections.map(({ id }) => ({ id, text: `Working chapter for ${id}`, example: `Example for ${id}`, sourceIds: ["source-1", "made-up"] })),
    faces: faces.map((face) => ({ face, story: `A story on ${face}`, boundary: "Honor what the customer can expect.", preview: { ...preview, imagery: `${preview.imagery} This composition reflects ${face}.` } })),
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
  assert.deepEqual(brandChaptersAfterEdit(["Foundation", "Identity", "Strategy", "Practice"], "visual"), ["Foundation"]);
});

function founderReading() {
  return {
    origin: "I wanted to make an object that gives the first cup of the day its own moment.",
    belief: "A small deliberate action can make time feel like your own.",
    character: "Unhurried, tactile, and open to small surprises.",
    commitment: "Keep the same sequence to prepare the blend, and vary the seasonal wrapping.",
    openQuestion: "",
    axis: {
      domain: "How the morning cup takes shape",
      first: "Ritual",
      second: "Spontaneity",
      notFirst: "Actions without an intentional sequence",
      notSecond: "Actions without an unplanned choice",
    },
    readings: relationships.map(({ face, relation }) => ({
      face,
      interpretation: `The ${relation} reading explores ${face}.`,
      consequence: `A separate product consequence for ${face}.`,
    })),
  };
}

test("the creator-led reading keeps independent negations and every prescribed relationship", () => {
  const raw = founderReading();
  const found = normalizeBrandFoundation(raw);
  assert.deepEqual(found.readings.map(({ face }) => face), faces);
  assert.equal(found.belief, raw.belief);
  assert.deepEqual(relationships.map(({ terms }) => terms), [
    ["first", "second"], ["notFirst", "notSecond"], ["first", "notSecond"], ["second", "notFirst"], ["first", "notFirst"], ["second", "notSecond"],
  ]);
  assert.throws(() => normalizeBrandFoundation({ ...raw, axis: { ...raw.axis, notFirst: "spontaneity!" } }), { statusCode: 502 });
  assert.throws(() => normalizeBrandFoundation({ ...raw, readings: raw.readings.slice(1) }), { statusCode: 502 });
});

test("one creator-led draft uses the derived square with no purchase action", () => {
  const foundation = founderReading();
  const direction = {
    title: "Return to the gesture", thesis: foundation.belief, payoff: foundation.character, tradeoff: "Keep the first step a physical gesture.",
    focus: "first", proof: "Keep the order of preparation fixed.", theme,
    preview: { line: "A moment kept", expression: "Make space for the morning.", imagery: "One recurring frame", action: "Buy now" },
  };
  const input = { brandName: "Fable Coffee", audience: "Busy executives", axis: { first: "Buy", second: "Wait" }, foundation, direction };
  const corrections = { voice: { text: "Speak plainly.", example: "Pour slowly." } };
  const draft = normalizeGuidedDraft(input, "A note from the creator.", [], corrections);
  assert.deepEqual(draft.discovery.axis, foundation.axis);
  assert.equal(draft.discovery.audience, "");
  assert.equal(draft.discovery.directions.length, 1);
  assert.equal(draft.discovery.directions[0].id, draft.directionId);
  assert.equal(draft.discovery.directions[0].preview.headline, "A moment kept");
  assert.equal(draft.discovery.directions[0].preview.action, "");
  assert.deepEqual(draft.corrections, corrections);
  assert.throws(() => normalizeGuidedDraft({ ...input, direction: { ...direction, proof: "" } }, "", []), { statusCode: 502 });
});

test("the guide asks one open question and skips topics it already covered", () => {
  const answers = [{ topic: "project", question: "What are you working on?", answer: "An app for people who grow food." }];
  const followUp = { topic: "origin", question: "What made you want to build this app?" };
  assert.deepEqual(nextBrandQuestion(followUp, answers, 0), { status: "question", ...followUp });
  for (const question of ["Would you choose an app or a service?", "What is it? Who uses it?", "Do you want to try it?", "What are you working on?"]) {
    assert.equal(nextBrandQuestion({ ...followUp, question }, answers, 0).question, "What made you start this?");
  }
  const answered = [...answers, { ...followUp, answer: "I kept forgetting what I planted." }];
  assert.equal(nextBrandQuestion(followUp, answered, 0).topic, "care");
  assert.equal(nextBrandQuestion({ topic: "ready", question: "" }, answered, 0).status, "ready");
  assert.equal(nextBrandQuestion(followUp, [...answered, ...answers, ...answers], 0).status, "ready");
});

test("the starting foundation reads project evidence without independent market research", async (t) => {
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("Market search should not run during the foundation."); });
  const sources = await readBrandBuilderSources({
    materials: [{ name: "Founder notes", summary: "Every morning should have a small moment you own." }],
    sectorExpertise: { items: [{ kind: "market", statement: "Saved market material" }] },
  }, "", { OPENAI_API_KEY: "unused" }, { identityOnly: true });
  assert.deepEqual(sources.map(({ label, kind }) => ({ label, kind })), [{ label: "Founder notes", kind: "project" }]);
  assert.equal(network.mock.callCount(), 0);
});

test("a creator-led system requires meaning links in every section and visual rule", () => {
  const raw = fixture();
  const foundation = normalizeBrandFoundation(founderReading());
  const draft = { ...emptyBrandBuild().draft, foundation, discovery: { brandName: raw.name, sources: [] } };
  assert.throws(() => normalizeBrandSystem(raw, draft, { theme }), { statusCode: 502 });
  const meaning = { face: "first", consequence: "Use the repeated preparation sequence to give the product a sense of ritual." };
  const linked = {
    ...raw,
    sections: raw.sections.map((entry) => ({ ...entry, meaning })),
    guidelineMeanings: Object.keys(raw.guidelines).map((rule) => ({ rule, meaning })),
  };
  const system = normalizeBrandSystem(linked, draft, { theme });
  assert.equal(system.sections.length, 19);
  assert.ok(system.sections.every((entry) => entry.meaning.face === "first"));
  assert.equal(system.guidelineMeanings.length, 7);
  const projected = projectBrandProjection({ version: 2, axis: foundation.axis, foundation, system }, [], []);
  assert.equal(projected.foundation.belief, foundation.belief);
  assert.equal(projected.conclusions[0].meaning.consequence, meaning.consequence);
  assert.match(approvedBrandInstructions({ creativeBrand: projected }), /creator’s approved worldview/);
  assert.throws(() => normalizeBrandSystem({ ...linked, guidelineMeanings: linked.guidelineMeanings.slice(1) }, draft, { theme }), { statusCode: 502 });
  const isolatedVocabulary = linked.words.map((word, index) => ({ ...word, links: [{ id: `word-${index ^ 1}`, reason: "Only related within this isolated pair." }] }));
  assert.throws(() => normalizeBrandSystem({ ...linked, words: isolatedVocabulary }, draft, { theme }), { statusCode: 502 });
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
