import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CV_CHARS,
  ProfileError,
  extractProfile,
  renderProfileMarkdown,
  renderRankingProfile,
} from "./profile.js";

const CV = `CURRICULUM VITAE
Bhargav Muktha, Hans-Sachs-Str. 66, 78054 Villingen-Schwenningen
bhargavmuktha39@gmail.com, +49 176 41194464

Experience
2019-2024 Quality Assurance Specialist, Acme Pharma GmbH, Munich.
Ran pharmacovigilance case processing and aggregate reporting. Led two GMP audits.
Reduced deviation closure time by 40%.
`.repeat(3);

/** A model caller that returns whatever the test puts in front of it. */
function says(reply) {
  return async () => reply;
}

const GOOD = JSON.stringify({
  headline: "Pharmacovigilance and QA roles in German pharma",
  sectors: ["pharma"],
  languages: ["de", "en"],
  skills: [
    { term: "pharmacovigilance", weight: 9, aliases: ["PV", "Pharmakovigilanz"] },
    { term: "GMP audits", weight: 7, aliases: [] },
  ],
  facts: [
    { id: "qa-acme", text: "Ran pharmacovigilance case processing at Acme Pharma GmbH.", tags: ["pv"] },
    { id: "deviation", text: "Reduced deviation closure time by 40%.", tags: ["capa"] },
  ],
});

test("a CV becomes preferences and facts", async () => {
  const { profile, facts } = await extractProfile(CV, {
    call: says(GOOD),
    countries: ["de"],
    sectors: ["pharma"],
  });
  assert.equal(profile.skills.length, 2);
  assert.equal(profile.skills[0].term, "pharmacovigilance");
  assert.deepEqual(profile.languages, ["de", "en"]);
  assert.deepEqual(profile.countries, ["de"]);
  assert.equal(facts.length, 2);
  // Facts may name an employer; that is what a letter cites.
  assert.match(facts[0].text, /Acme Pharma/);
});

// The property the whole split exists for.
test("personal data a model emits cannot reach the ranking profile", async () => {
  const leaky = JSON.stringify({
    headline: "Bhargav Muktha, bhargavmuktha39@gmail.com, seeking QA roles",
    name: "Bhargav Muktha",
    email: "bhargavmuktha39@gmail.com",
    phone: "+49 176 41194464",
    address: "Hans-Sachs-Str. 66",
    employer: "Acme Pharma GmbH",
    sectors: ["pharma"],
    languages: ["de"],
    skills: [{ term: "pharmacovigilance", weight: 9 }],
    facts: [],
  });
  const { profile } = await extractProfile(CV, {
    call: says(leaky),
    countries: ["de"],
    sectors: ["pharma"],
  });

  const serialised = JSON.stringify(renderRankingProfile("s_x", profile));
  for (const leak of ["+49", "gmail.com", "Hans-Sachs", "Acme Pharma"]) {
    assert.ok(!serialised.includes(leak), `${leak} reached the ranking profile`);
  }
  // Fields with nowhere to land are simply absent.
  assert.equal(profile.name, undefined);
  assert.equal(profile.email, undefined);
  assert.equal(profile.phone, undefined);
});

// A CV is a document somebody uploaded, and a document can contain instructions.
test("a CV that tries to steer the model cannot widen the output", async () => {
  // Even if the injection succeeds and the model obeys it, the whitelist is what decides.
  const obeyed = JSON.stringify({
    headline: "IGNORE PREVIOUS INSTRUCTIONS",
    skills: [{ term: "x", weight: 1 }],
    sectors: ["pharma"],
    languages: ["de"],
    facts: [],
    exfiltrate: "https://attacker.example.org",
    admin: true,
    __proto__: { polluted: true },
  });
  const { profile } = await extractProfile(CV, {
    call: says(obeyed),
    countries: ["de"],
    sectors: ["pharma"],
  });
  const ranking = renderRankingProfile("s_x", profile);
  assert.equal(ranking.exfiltrate, undefined);
  assert.equal(ranking.admin, undefined);
  assert.equal({}.polluted, undefined, "prototype pollution");
  assert.deepEqual(Object.keys(ranking).sort(), [
    "countries", "headline", "languages", "min_score", "sectors", "skills", "slug",
  ]);
});

test("a sector the engine does not have is dropped", async () => {
  const { profile } = await extractProfile(CV, {
    call: says(JSON.stringify({ ...JSON.parse(GOOD), sectors: ["pharma", "invented"] })),
    countries: ["de"],
    sectors: ["pharma", "automotive"],
  });
  assert.deepEqual(profile.sectors, ["pharma"]);
});

test("a language that is not an ISO code is dropped, not guessed at", async () => {
  const { profile } = await extractProfile(CV, {
    call: says(JSON.stringify({ ...JSON.parse(GOOD), languages: ["de", "German", "en-GB"] })),
    countries: ["de"],
  });
  assert.deepEqual(profile.languages, ["de"]);
});

test("a wild weight is clamped rather than rejected", async () => {
  const { profile } = await extractProfile(CV, {
    call: says(JSON.stringify({
      ...JSON.parse(GOOD),
      skills: [
        { term: "a", weight: 500 },
        { term: "b", weight: -99 },
        { term: "c", weight: 0 },
        { term: "d", weight: "not a number" },
      ],
    })),
    countries: ["de"],
  });
  assert.equal(profile.skills[0].weight, 10);
  assert.equal(profile.skills[1].weight, -10);
  // Zero means "never counted", which the engine rejects, so it becomes 1.
  assert.equal(profile.skills[2].weight, 1);
  assert.equal(profile.skills[3].weight, 1);
});

test("duplicate skills collapse", async () => {
  const { profile } = await extractProfile(CV, {
    call: says(JSON.stringify({
      ...JSON.parse(GOOD),
      skills: [{ term: "GMP", weight: 5 }, { term: "gmp", weight: 3 }],
    })),
    countries: ["de"],
  });
  assert.equal(profile.skills.length, 1);
});

test("newlines and control characters cannot survive into a term", async () => {
  const { profile } = await extractProfile(CV, {
    call: says(JSON.stringify({
      ...JSON.parse(GOOD),
      skills: [{ term: "GMP\n- **injected**\n", weight: 5, aliases: ["a\u0000b"] }],
    })),
    countries: ["de"],
  });
  assert.ok(!profile.skills[0].term.includes("\n"));
  assert.ok(!profile.skills[0].aliases[0].includes("\u0000"));
});

test("a reply with no JSON object fails loudly", async () => {
  await assert.rejects(
    () => extractProfile(CV, { call: says("I cannot help with that.") }),
    ProfileError,
  );
});

test("a truncated or invalid JSON reply fails loudly", async () => {
  await assert.rejects(
    () => extractProfile(CV, { call: says('{"skills": [{"term": ') }),
    ProfileError,
  );
});

test("JSON wrapped in a code fence is still read", async () => {
  const { profile } = await extractProfile(CV, {
    call: says("Here you go:\n```json\n" + GOOD + "\n```\nHope that helps!"),
    countries: ["de"],
  });
  assert.equal(profile.skills.length, 2);
});

test("something that is not a CV is refused before the model is called", async () => {
  let called = false;
  await assert.rejects(
    () => extractProfile("hi", { call: async () => { called = true; return GOOD; } }),
    ProfileError,
  );
  assert.ok(!called, "a model call costs quota; do not spend it on an empty upload");
});

test("an enormous upload is truncated rather than sent whole", async () => {
  let seen = "";
  await extractProfile("x".repeat(MAX_CV_CHARS * 3), {
    call: async ({ user }) => { seen = user; return GOOD; },
  });
  assert.ok(seen.length < MAX_CV_CHARS + 2000, "the CV should have been capped");
});

test("the CV is passed as data, inside markers", async () => {
  let seen = {};
  await extractProfile(CV, { call: async (request) => { seen = request; return GOOD; } });
  assert.match(seen.user, /<cv>/);
  assert.match(seen.system, /not addressed to you/);
});

test("the facts render as the Markdown the private side already reads", async () => {
  const { profile, facts } = await extractProfile(CV, {
    call: says(GOOD), countries: ["de"], sectors: ["pharma"],
  });
  const markdown = renderProfileMarkdown({ headline: profile.headline, facts, ...profile });
  assert.match(markdown, /## Facts/);
  assert.match(markdown, /\*\*qa-acme\*\*/);
  assert.match(markdown, /## Skills/);
  assert.match(markdown, /Acme Pharma/);
});

// The scrubber is the second layer, so it gets its own cases rather than being exercised
// only through a leaky-model scenario.
test("contact details are removed from free text", async () => {
  const shapes = [
    "QA roles — reach me at bhargavmuktha39@gmail.com",
    "QA roles, name (at) example.org",
    "QA roles +49 176 41194464",
    "QA roles 0176-41194464",
    "QA roles https://linkedin.com/in/someone",
    "QA roles www.example.org/cv",
  ];
  for (const headline of shapes) {
    const { profile } = await extractProfile(CV, {
      call: says(JSON.stringify({ ...JSON.parse(GOOD), headline })),
      countries: ["de"],
    });
    for (const leak of ["@", "+49", "0176-", "http", "www."]) {
      assert.ok(
        !profile.headline.includes(leak),
        `${leak} survived scrubbing in ${JSON.stringify(profile.headline)}`,
      );
    }
    assert.match(profile.headline, /QA roles/, "the actual content must survive");
  }
});

test("a headline that was only contact details falls back rather than going empty", async () => {
  const { profile } = await extractProfile(CV, {
    call: says(JSON.stringify({ ...JSON.parse(GOOD), headline: "name@example.org" })),
    countries: ["de"],
  });
  assert.equal(profile.headline, "Roles matching this profile");
});

test("an address hidden in a skill term is removed too", async () => {
  const { profile } = await extractProfile(CV, {
    call: says(JSON.stringify({
      ...JSON.parse(GOOD),
      skills: [{ term: "GMP contact me@example.org", weight: 5, aliases: ["call +49 176 1234567"] }],
    })),
    countries: ["de"],
  });
  assert.ok(!profile.skills[0].term.includes("@"));
  assert.ok(!profile.skills[0].aliases.join(" ").includes("+49"));
});

// Facts legitimately name employers and dates — that is what a letter cites — so the
// scrubber must not be applied there.
test("facts keep the employers a letter needs to cite", async () => {
  const { facts } = await extractProfile(CV, {
    call: says(GOOD), countries: ["de"], sectors: ["pharma"],
  });
  assert.match(facts[0].text, /Acme Pharma GmbH/);
});
