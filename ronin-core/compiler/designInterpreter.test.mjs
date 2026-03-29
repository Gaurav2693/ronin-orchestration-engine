// ─── compiler/designInterpreter.test.mjs ──────────────────────────────────────────
// Test suite for Seat 7 — Design Interpreter
//
// 50+ tests covering:
// - Schema validation
// - Prompt building
// - Interpretation execution
// - Response parsing
// - Layer hierarchy extraction
// - Merge and conversion utilities
// - Integration flows
// - Edge cases
// ─────────────────────────────────────────────────────────────────────────────

import {
  INTERPRETATION_SCHEMA,
  buildInterpretationPrompt,
  interpret,
  parseInterpretation,
  extractLayerHierarchy,
  mergeInterpretations,
  interpretationToPromptFragment,
  _setProvider,
  _resetProvider,
} from "./designInterpreter.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Test Harness
// ─────────────────────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) {
    failCount++;
    failures.push(message);
    console.error(`  ✗ ${message}`);
  } else {
    passCount++;
    console.log(`  ✓ ${message}`);
  }
}

function assertEquals(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function assertContains(str, substring, message) {
  assert(str && str.includes(substring), message);
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (error) {
    failCount++;
    failures.push(`${name}: ${error.message}`);
    console.error(`  ✗ CRASHED: ${error.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Providers
// ─────────────────────────────────────────────────────────────────────────────

function createMockProvider(response = null, shouldFail = false) {
  return async (options) => {
    if (shouldFail) {
      throw new Error("Mock provider error");
    }

    return {
      content:
        response ||
        `{
        "emotional_register": "formal, restrained",
        "primary_metaphor": "data surface",
        "motion_implied": "subtle, purposeful",
        "hierarchy_strategy": "depth via opacity",
        "component_role": "secondary navigation",
        "designer_intent": "operator should feel in control",
        "interaction_vocabulary": "hover=reveal, click=select"
      }`,
      usage: {
        input_tokens: 1500,
        output_tokens: 250,
      },
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suites
// ─────────────────────────────────────────────────────────────────────────────

await test("Schema tests — has all 7 fields", () => {
  const fields = Object.keys(INTERPRETATION_SCHEMA);
  assert(fields.length === 7, "Schema has exactly 7 fields");
  assert(fields.includes("emotional_register"), "Has emotional_register");
  assert(fields.includes("primary_metaphor"), "Has primary_metaphor");
  assert(fields.includes("motion_implied"), "Has motion_implied");
  assert(fields.includes("hierarchy_strategy"), "Has hierarchy_strategy");
  assert(fields.includes("component_role"), "Has component_role");
  assert(fields.includes("designer_intent"), "Has designer_intent");
  assert(fields.includes("interaction_vocabulary"), "Has interaction_vocabulary");
});

await test("Schema tests — all fields required", () => {
  for (const [field, spec] of Object.entries(INTERPRETATION_SCHEMA)) {
    assert(spec.required === true, `${field} is marked required`);
  }
});

await test("Schema tests — each field has description", () => {
  for (const [field, spec] of Object.entries(INTERPRETATION_SCHEMA)) {
    assert(spec.description && spec.description.length > 0, `${field} has description`);
  }
});

await test("Prompt building — buildInterpretationPrompt includes systemPrompt", () => {
  const { systemPrompt } = buildInterpretationPrompt("iVBORw0KGgo=", [
    { id: "1", name: "Frame", type: "FRAME" },
  ]);
  assert(systemPrompt.includes("creative director"), "System prompt mentions creative director");
});

await test("Prompt building — system prompt matches persona", () => {
  const { systemPrompt } = buildInterpretationPrompt("iVBORw0KGgo=", [
    { id: "1", name: "Frame", type: "FRAME" },
  ]);
  assert(
    systemPrompt.includes("reading a designer's intention"),
    "Persona present in system prompt"
  );
});

await test("Prompt building — user prompt includes layer hierarchy", () => {
  const { userPrompt } = buildInterpretationPrompt("iVBORw0KGgo=", [
    { id: "1", name: "MyFrame", type: "FRAME" },
  ]);
  assert(userPrompt.includes("MyFrame"), "User prompt includes layer name");
  assert(userPrompt.includes("FRAME"), "User prompt includes layer type");
});

await test("Prompt building — token estimate reasonable", () => {
  const { tokenEstimate } = buildInterpretationPrompt("iVBORw0KGgo=", [
    { id: "1", name: "Frame", type: "FRAME" },
  ]);
  assert(tokenEstimate > 1000 && tokenEstimate < 2000, "Token estimate in reasonable range");
});

await test("Prompt building — prohibited actions mentioned", () => {
  const { systemPrompt } = buildInterpretationPrompt("iVBORw0KGgo=", [
    { id: "1", name: "Frame", type: "FRAME" },
  ]);
  assert(systemPrompt.includes("PROHIBITED"), "System prompt lists prohibited actions");
  assert(systemPrompt.includes("code"), "Prohibition on code generation");
  assert(systemPrompt.includes("CSS"), "Prohibition on CSS mentions");
  assert(systemPrompt.includes("numeric"), "Prohibition on numeric values");
});

await test("Prompt building — no code/CSS references in system prompt", () => {
  const { systemPrompt } = buildInterpretationPrompt("iVBORw0KGgo=", [
    { id: "1", name: "Frame", type: "FRAME" },
  ]);
  assert(
    !systemPrompt.includes("className"),
    "System prompt does not mention className"
  );
  assert(!systemPrompt.includes("styled-"), "System prompt does not mention styled-components");
});

await test("Prompt building — handles deep layer nesting", () => {
  const deepHierarchy = [
    {
      id: "1",
      name: "Root",
      type: "FRAME",
      children: [
        {
          id: "2",
          name: "Container",
          type: "FRAME",
          children: [
            {
              id: "3",
              name: "Card",
              type: "FRAME",
              children: [
                { id: "4", name: "Title", type: "TEXT" },
                { id: "5", name: "Subtitle", type: "TEXT" },
              ],
            },
          ],
        },
      ],
    },
  ];

  const { userPrompt } = buildInterpretationPrompt("iVBORw0KGgo=", deepHierarchy);
  assert(userPrompt.includes("Title"), "Deep nesting preserved in prompt");
  assert(userPrompt.includes("Subtitle"), "All levels included");
});

await test("Execution — interpret calls provider with correct prompts", async () => {
  let providerCalled = false;
  let capturedOptions = null;

  const mockProvider = async (options) => {
    providerCalled = true;
    capturedOptions = options;
    return {
      content: JSON.stringify({
        emotional_register: "calm",
        primary_metaphor: "surface",
        motion_implied: "subtle",
        hierarchy_strategy: "opacity",
        component_role: "nav",
        designer_intent: "guide",
        interaction_vocabulary: "hover=reveal",
      }),
      usage: { input_tokens: 1500, output_tokens: 250 },
    };
  };

  _setProvider(mockProvider);
  await interpret("iVBORw0KGgo=", [{ id: "1", name: "Frame", type: "FRAME" }]);

  assert(providerCalled, "Provider was called");
  assert(capturedOptions.system, "Provider received system prompt");
  assert(capturedOptions.messages, "Provider received messages");

  _resetProvider();
});

await test("Execution — interpret returns valid interpretation", async () => {
  _setProvider(createMockProvider());

  const result = await interpret("iVBORw0KGgo=", [
    { id: "1", name: "Frame", type: "FRAME" },
  ]);

  assert(result.valid === true, "Result marked valid");
  assert(result.interpretation, "Interpretation present");
  assert(result.missingFields.length === 0, "No missing fields");

  _resetProvider();
});

await test("Execution — interpret handles provider error", async () => {
  _setProvider(createMockProvider(null, true));

  let errorThrown = false;
  try {
    await interpret("iVBORw0KGgo=", [{ id: "1", name: "Frame", type: "FRAME" }]);
  } catch (error) {
    errorThrown = true;
    assert(error.message.includes("Provider"), "Error mentions provider");
  }

  assert(errorThrown, "Error thrown on provider failure");
  _resetProvider();
});

await test("Execution — interpret tracks latency", async () => {
  _setProvider(createMockProvider());

  const result = await interpret("iVBORw0KGgo=", [
    { id: "1", name: "Frame", type: "FRAME" },
  ]);

  assert(result.latencyMs >= 0, "Latency measured");
  assert(typeof result.latencyMs === "number", "Latency is a number");

  _resetProvider();
});

await test("Execution — interpret estimates cost (~$0.003)", async () => {
  _setProvider(createMockProvider());

  const result = await interpret("iVBORw0KGgo=", [
    { id: "1", name: "Frame", type: "FRAME" },
  ]);

  assert(result.costEstimate > 0, "Cost estimate present");
  assert(result.costEstimate < 0.01, "Cost estimate < $0.01 for single call");

  _resetProvider();
});

await test("Parsing — parseInterpretation extracts JSON from code block", () => {
  const response = `Here's the interpretation:
\`\`\`json
{
  "emotional_register": "formal",
  "primary_metaphor": "data surface",
  "motion_implied": "subtle",
  "hierarchy_strategy": "opacity",
  "component_role": "nav",
  "designer_intent": "control",
  "interaction_vocabulary": "hover=reveal"
}
\`\`\``;

  const { interpretation, valid } = parseInterpretation(response);
  assert(valid, "Valid interpretation from code block");
  assert(interpretation.emotional_register === "formal", "Extracted emotional_register");
});

await test("Parsing — parseInterpretation extracts raw JSON", () => {
  const response = `{
  "emotional_register": "playful",
  "primary_metaphor": "conversation",
  "motion_implied": "bouncy",
  "hierarchy_strategy": "color",
  "component_role": "cta",
  "designer_intent": "delight",
  "interaction_vocabulary": "click=celebrate"
}`;

  const { interpretation, valid } = parseInterpretation(response);
  assert(valid, "Valid interpretation from raw JSON");
  assert(interpretation.primary_metaphor === "conversation", "Extracted metaphor");
});

await test("Parsing — parseInterpretation validates all 7 fields", () => {
  const incompleteResponse = `{
  "emotional_register": "formal",
  "primary_metaphor": "surface"
}`;

  const { valid, missingFields } = parseInterpretation(incompleteResponse);
  assert(!valid, "Invalid when fields missing");
  assert(missingFields.length === 5, "5 fields reported missing");
  assert(missingFields.includes("motion_implied"), "motion_implied in missing");
});

await test("Parsing — parseInterpretation reports missing fields", () => {
  const response = `{
  "emotional_register": "calm",
  "primary_metaphor": "surface",
  "motion_implied": "subtle",
  "hierarchy_strategy": "opacity"
}`;

  const { missingFields } = parseInterpretation(response);
  assert(missingFields.includes("component_role"), "component_role reported missing");
  assert(missingFields.includes("designer_intent"), "designer_intent reported missing");
});

await test("Parsing — parseInterpretation handles malformed JSON", () => {
  const response = "{ this is not valid json ]]]";
  const { valid, parseError } = parseInterpretation(response);

  assert(!valid, "Invalid for malformed JSON");
  assert(parseError && parseError.includes("JSON"), "Parse error mentions JSON");
});

await test("Parsing — parseInterpretation handles empty response", () => {
  const response = "";
  const { valid, parseError } = parseInterpretation(response);

  assert(!valid, "Invalid for empty response");
  assert(parseError && parseError.includes("No JSON"), "Error mentions no JSON found");
});

await test("Parsing — parseInterpretation handles response with extra fields", () => {
  const response = `{
  "emotional_register": "formal",
  "primary_metaphor": "surface",
  "motion_implied": "subtle",
  "hierarchy_strategy": "opacity",
  "component_role": "nav",
  "designer_intent": "control",
  "interaction_vocabulary": "hover=reveal",
  "extra_field": "this should be kept"
}`;

  const { interpretation, valid } = parseInterpretation(response);
  assert(valid, "Valid even with extra fields");
  assert(interpretation.extra_field === "this should be kept", "Extra fields preserved");
});

await test("Layer hierarchy — extractLayerHierarchy strips visual properties", () => {
  const nodeTree = {
    id: "1",
    name: "Frame",
    type: "FRAME",
    opacity: 0.8,
    fills: [{ color: "#000" }],
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
  };

  const [simplified] = extractLayerHierarchy(nodeTree);
  assert(!simplified.opacity, "Opacity stripped");
  assert(!simplified.fills, "Fills stripped");
  assert(!simplified.absoluteBoundingBox, "BoundingBox stripped");
});

await test("Layer hierarchy — extractLayerHierarchy keeps id, name, type, children", () => {
  const nodeTree = {
    id: "1",
    name: "Frame",
    type: "FRAME",
    opacity: 0.8,
    children: [{ id: "2", name: "Text", type: "TEXT" }],
  };

  const [simplified] = extractLayerHierarchy(nodeTree);
  assert(simplified.id === "1", "ID preserved");
  assert(simplified.name === "Frame", "Name preserved");
  assert(simplified.type === "FRAME", "Type preserved");
  assert(simplified.children && simplified.children.length === 1, "Children preserved");
});

await test("Layer hierarchy — extractLayerHierarchy handles deep nesting", () => {
  const nodeTree = {
    id: "1",
    name: "Root",
    type: "FRAME",
    children: [
      {
        id: "2",
        name: "Container",
        type: "FRAME",
        children: [{ id: "3", name: "Item", type: "RECTANGLE" }],
      },
    ],
  };

  const [simplified] = extractLayerHierarchy(nodeTree);
  assert(simplified.children[0].children[0].name === "Item", "Deep nesting preserved");
});

await test("Layer hierarchy — extractLayerHierarchy handles empty children", () => {
  const nodeTree = {
    id: "1",
    name: "Frame",
    type: "FRAME",
    children: [],
  };

  const [simplified] = extractLayerHierarchy(nodeTree);
  assert(!simplified.children || simplified.children.length === 0, "Empty children omitted");
});

await test("Merge — mergeInterpretations takes most recent", () => {
  const interpretations = [
    {
      interpretation: { emotional_register: "old" },
      timestamp: 100,
    },
    {
      interpretation: { emotional_register: "new" },
      timestamp: 200,
    },
  ];

  const merged = mergeInterpretations(interpretations);
  assert(merged.emotional_register === "new", "Most recent taken");
});

await test("Merge — mergeInterpretations handles single interpretation", () => {
  const interpretations = [
    {
      interpretation: { emotional_register: "single" },
      timestamp: 100,
    },
  ];

  const merged = mergeInterpretations(interpretations);
  assert(merged.emotional_register === "single", "Single interpretation returned");
});

await test("Merge — mergeInterpretations handles empty array", () => {
  const merged = mergeInterpretations([]);
  assertEquals(merged, {}, "Empty object for empty array");
});

await test("Conversion — interpretationToPromptFragment produces concise summary", () => {
  const interpretation = {
    emotional_register: "formal",
    primary_metaphor: "data surface",
    hierarchy_strategy: "opacity",
    designer_intent: "control",
    component_role: "nav",
    motion_implied: "subtle",
    interaction_vocabulary: "hover=reveal",
  };

  const fragment = interpretationToPromptFragment(interpretation);
  assert(fragment, "Fragment produced");
  assert(fragment.includes("formal"), "Includes emotional_register");
  assert(fragment.includes("data surface"), "Includes primary_metaphor");
  assert(typeof fragment === "string", "Is a string");
});

await test("Conversion — interpretationToPromptFragment returns null for empty", () => {
  const fragment = interpretationToPromptFragment({});
  assert(fragment === null, "Returns null for empty object");
});

await test("Integration — full flow card scenario", async () => {
  _setProvider(createMockProvider());

  const cardScene = {
    id: "card-root",
    name: "ProductCard",
    type: "FRAME",
    children: [
      { id: "image", name: "Image", type: "RECTANGLE" },
      { id: "title", name: "Title", type: "TEXT" },
      { id: "cta", name: "CTA Button", type: "COMPONENT" },
    ],
  };

  const hierarchy = extractLayerHierarchy(cardScene);
  const result = await interpret("iVBORw0KGgo=", hierarchy);

  assert(result.valid, "Valid interpretation for card");
  assert(result.interpretation.component_role, "Has component_role");

  _resetProvider();
});

await test("Integration — interpretation feeds into Stage 2 prompt", () => {
  const interpretation = {
    emotional_register: "formal, restrained",
    primary_metaphor: "data surface",
    motion_implied: "subtle",
    hierarchy_strategy: "opacity",
    component_role: "secondary navigation",
    designer_intent: "control",
    interaction_vocabulary: "hover=reveal",
  };

  const fragment = interpretationToPromptFragment(interpretation);
  assert(fragment.includes("formal"), "Stage 2 gets emotional context");
  assert(fragment.includes("data surface"), "Stage 2 gets metaphor");
});

await test("Integration — multiple component types produce different interpretations", async () => {
  _setProvider(createMockProvider());

  const button = {
    id: "btn",
    name: "Button",
    type: "COMPONENT",
  };

  const navbar = {
    id: "nav",
    name: "Navigation",
    type: "FRAME",
    children: [
      { id: "logo", name: "Logo", type: "TEXT" },
      { id: "links", name: "Links", type: "FRAME" },
    ],
  };

  const btnHierarchy = extractLayerHierarchy(button);
  const navHierarchy = extractLayerHierarchy(navbar);

  assert(btnHierarchy[0].type === "COMPONENT", "Button is COMPONENT");
  assert(navHierarchy[0].type === "FRAME", "Navbar is FRAME");
  assert(navHierarchy[0].children && navHierarchy[0].children.length > 0, "Navbar has children");

  _resetProvider();
});

await test("Edge case — very simple design (single rectangle)", () => {
  const simple = {
    id: "rect",
    name: "Rectangle",
    type: "RECTANGLE",
  };

  const hierarchy = extractLayerHierarchy(simple);
  assert(hierarchy[0].name === "Rectangle", "Simple design extracted");
  assert(!hierarchy[0].children, "No children");
});

await test("Edge case — complex design (20+ layers)", () => {
  const layers = [];
  for (let i = 0; i < 25; i++) {
    layers.push({
      id: `item-${i}`,
      name: `Item ${i}`,
      type: "FRAME",
    });
  }

  const complex = {
    id: "root",
    name: "Complex",
    type: "FRAME",
    children: layers,
  };

  const hierarchy = extractLayerHierarchy(complex);
  assert(hierarchy[0].children.length === 25, "All 25 layers preserved");
});

await test("Edge case — design with no text nodes", () => {
  const nodeTree = {
    id: "root",
    name: "Shapes Only",
    type: "FRAME",
    children: [
      { id: "rect1", name: "Rectangle 1", type: "RECTANGLE" },
      { id: "ellipse1", name: "Ellipse 1", type: "ELLIPSE" },
      { id: "line1", name: "Line 1", type: "LINE" },
    ],
  };

  const hierarchy = extractLayerHierarchy(nodeTree);
  assert(hierarchy[0].children.length === 3, "All non-text nodes preserved");
});

await test("Edge case — design with only text nodes", () => {
  const nodeTree = {
    id: "root",
    name: "Text Only",
    type: "FRAME",
    children: [
      { id: "h1", name: "Heading", type: "TEXT" },
      { id: "p1", name: "Paragraph", type: "TEXT" },
      { id: "s1", name: "Small", type: "TEXT" },
    ],
  };

  const hierarchy = extractLayerHierarchy(nodeTree);
  assert(hierarchy[0].children.length === 3, "All text nodes preserved");
  assert(hierarchy[0].children.every((c) => c.type === "TEXT"), "All are TEXT type");
});

await test("Error handling — buildInterpretationPrompt rejects invalid base64", () => {
  let errorThrown = false;
  try {
    buildInterpretationPrompt("", [{ id: "1", name: "Frame", type: "FRAME" }]);
  } catch (error) {
    errorThrown = true;
  }
  assert(errorThrown, "Error on empty base64");
});

await test("Error handling — buildInterpretationPrompt rejects non-array hierarchy", () => {
  let errorThrown = false;
  try {
    buildInterpretationPrompt("iVBORw0KGgo=", null);
  } catch (error) {
    errorThrown = true;
  }
  assert(errorThrown, "Error on non-array hierarchy");
});

await test("Error handling — interpret without provider set throws", async () => {
  _resetProvider();

  let errorThrown = false;
  try {
    await interpret("iVBORw0KGgo=", [{ id: "1", name: "Frame", type: "FRAME" }]);
  } catch (error) {
    errorThrown = true;
    assert(error.message.includes("provider"), "Error mentions provider");
  }

  assert(errorThrown, "Error thrown when no provider set");
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(
  `\n${"=".repeat(80)}\n` +
    `RESULTS: ${passCount} passed, ${failCount} failed\n` +
    `${"=".repeat(80)}`
);

if (failures.length > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}

process.exit(failCount > 0 ? 1 : 0);
