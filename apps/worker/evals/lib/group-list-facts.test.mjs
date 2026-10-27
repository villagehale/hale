import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GROUP_LISTS_FIXTURES as FIXTURES } from "../group-lists-fixtures.mjs";
import { groupListsJudgePayload, listChanges } from "./group-list-facts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (name) => readFileSync(join(HERE, "fixtures-918", name), "utf8");
const byId = (id) => FIXTURES.find((f) => f.id === id);

// The real readGroupLists() snapshots the #918 judge got (cached-only replay at eeff7c1a).
const SEVERAL_BEFORE = [
  {
    listId: "L1",
    name: "Groceries",
    items: [
      { itemId: "i2", text: "milk", addedBy: "Jordan" },
      { itemId: "i3", text: "yogurt", addedBy: "Jordan" },
    ],
  },
];
const SEVERAL_AFTER = [
  {
    listId: "L1",
    name: "Groceries",
    items: [
      { itemId: "i5", text: "bananas", addedBy: "Dana" },
      { itemId: "i4", text: "bread", addedBy: "Dana" },
      { itemId: "i2", text: "milk", addedBy: "Jordan" },
      { itemId: "i3", text: "yogurt", addedBy: "Jordan" },
    ],
  },
];
const AR_LISTS = [
  {
    listId: "L1",
    name: "قائمة المشتريات",
    items: [
      { itemId: "i3", text: "حليب", addedBy: "ليلى" },
      { itemId: "i2", text: "خبز", addedBy: "ليلى" },
    ],
  },
];

describe("group-lists judge gets who-did-what as data (#918)", () => {
  it("en-several-at-once: the prompt carries the adds by Dana and the milk already on from Jordan", () => {
    const payload = groupListsJudgePayload({
      fixture: byId("en-several-at-once"),
      reply:
        "Added bread and bananas to Groceries. Milk was already on there from Jordan.",
      before: SEVERAL_BEFORE,
      after: SEVERAL_AFTER,
    });
    expect(payload.facts.sender).toEqual({
      name: "Dana Smith",
      shownAs: "Dana",
    });
    expect(payload.facts.changes).toEqual({
      added: [
        { list: "Groceries", item: "bananas", addedBy: "Dana" },
        { list: "Groceries", item: "bread", addedBy: "Dana" },
      ],
      alreadyOn: [
        { list: "Groceries", item: "milk", addedBy: "Jordan" },
        { list: "Groceries", item: "yogurt", addedBy: "Jordan" },
      ],
      checkedOff: [],
    });
    // What the judge model is actually sent: harness judge() JSON.stringify()s the payload.
    const userMessage = JSON.stringify(payload);
    expect(userMessage).toContain(
      '"changes":{"added":[{"list":"Groceries","item":"bananas","addedBy":"Dana"}',
    );
  });

  it("ar-whats-on: the sender is Omar and both items were added by Leila, in real script", () => {
    const payload = groupListsJudgePayload({
      fixture: byId("ar-whats-on"),
      reply: "على قائمة المشتريات حليب وخبز، وليلى هي اللي أضافتهم.",
      before: AR_LISTS,
      after: AR_LISTS,
    });
    expect(payload.facts.sender).toEqual({ name: "عمر حسن", shownAs: "عمر" });
    expect(payload.facts.changes.added).toEqual([]);
    expect(payload.facts.changes.alreadyOn.map((r) => r.addedBy)).toEqual([
      "ليلى",
      "ليلى",
    ]);
    const userMessage = JSON.stringify(payload);
    expect(userMessage).toContain(
      '"sender":{"name":"عمر حسن","shownAs":"عمر"}',
    );
    expect(userMessage).not.toMatch(/\\u[0-9a-f]{4}/i);
  });

  it("a check-off lands in checkedOff with who had added it", () => {
    const before = [
      {
        listId: "L",
        name: "G",
        items: [{ itemId: "a", text: "rice", addedBy: "Yui" }],
      },
    ];
    expect(
      listChanges(before, [{ listId: "L", name: "G", items: [] }]),
    ).toEqual({
      added: [],
      alreadyOn: [],
      checkedOff: [{ list: "G", item: "rice", addedBy: "Yui" }],
    });
  });
});

describe("cached #918 judge reasons round-trip as UTF-8 (no decode step of ours)", () => {
  // Real cache records from the re-record. cachePut writes JSON.stringify(value, null, 2) and
  // cacheGet reads it back as utf8; if any step of ours re-decoded the text, rewriting the
  // parsed record would not reproduce the file byte for byte.
  const files = [
    "zh-add-and-ask-judge-escaped.json",
    "zh-add-and-ask-judge-clean.json",
    "fr-vous-add-judge-mojibake.json",
    "fr-vous-add-judge-clean.json",
  ];
  for (const name of files) {
    it(`${name} re-serialises byte for byte`, () => {
      const text = raw(name);
      expect(
        Buffer.from(JSON.stringify(JSON.parse(text), null, 2), "utf8").equals(
          Buffer.from(text, "utf8"),
        ),
      ).toBe(true);
    });
  }

  it("the sibling draws, same input, kept their CJK and accents intact", () => {
    expect(
      JSON.parse(raw("zh-add-and-ask-judge-clean.json")).parsed.reason,
    ).toContain("伟");
    expect(
      JSON.parse(raw("fr-vous-add-judge-clean.json")).parsed.reason,
    ).toContain("C'est ajouté à la liste Épicerie");
  });

  it("the two glitches are in the verdict the model returned, not added on read", () => {
    const zh = JSON.parse(raw("zh-add-and-ask-judge-escaped.json")).parsed
      .reason;
    // A backspace control char followed by the code point's hex: the model wrote "\bu4f1f"
    // inside its tool-call JSON. Decoded correctly that is U+0008 + "u4f1f", never 伟.
    expect(zh).toContain("\bu4f1f");
    expect(zh).not.toContain("伟");
    const fr = JSON.parse(raw("fr-vous-add-judge-mojibake.json")).parsed.reason;
    // "é" as UTF-8 (C3 A9) read as windows-1251 is "Г©". The stored text already holds the
    // Cyrillic code points; reading the file as utf8 is what turns them back into "Г©".
    expect(fr).toContain("ajoutГ©");
    expect(
      new TextDecoder("windows-1251").decode(Buffer.from("ajouté", "utf8")),
    ).toBe("ajoutГ©");
  });
});
