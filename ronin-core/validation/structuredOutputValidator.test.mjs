// validation/structuredOutputValidator.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Test suite for structuredOutputValidator.
//
// Tests cover:
//   - Valid JSON matching schemas passes validation
//   - Malformed JSON is caught with error
//   - Unknown taskTypes are allowed (prose output)
//   - needsStructuredOutput reports correct schemas
//   - Each schema rejects bad data appropriately
// ─────────────────────────────────────────────────────────────────────────────

import { validateStructured, needsStructuredOutput, getSchemaNames } from './structuredOutputValidator.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Test: task_classification schema validation
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[TEST] task_classification schema - valid input');
const validClassification = {
  taskType: 'code',
  confidence: 0.85,
  signals: ['User said "write a function"', 'Code keywords detected'],
};
const result1 = validateStructured(validClassification, 'task_classification');
console.assert(result1.valid === true, 'Should accept valid classification');
console.assert(result1.parsed.taskType === 'code', 'Should parse taskType');

console.log('[TEST] task_classification schema - missing required field');
const invalidClassification = {
  taskType: 'code',
  confidence: 0.85,
  // signals array is missing
};
const result2 = validateStructured(invalidClassification, 'task_classification');
console.assert(result2.valid === false, 'Should reject missing signals');
console.assert(result2.error.includes('validation'), 'Should include validation error');

console.log('[TEST] task_classification schema - invalid enum value');
const badEnum = {
  taskType: 'invalid_type',
  confidence: 0.85,
  signals: ['test'],
};
const result3 = validateStructured(badEnum, 'task_classification');
console.assert(result3.valid === false, 'Should reject invalid taskType enum');

console.log('[TEST] task_classification schema - confidence out of range');
const badConfidence = {
  taskType: 'code',
  confidence: 1.5, // Out of 0-1 range
  signals: ['test'],
};
const result4 = validateStructured(badConfidence, 'task_classification');
console.assert(result4.valid === false, 'Should reject confidence > 1');

console.log('[TEST] task_classification schema - empty signals array');
const noSignals = {
  taskType: 'code',
  confidence: 0.85,
  signals: [],
};
const result5 = validateStructured(noSignals, 'task_classification');
console.assert(result5.valid === false, 'Should require at least one signal');

// ─────────────────────────────────────────────────────────────────────────────
// Test: api_schema validation
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[TEST] api_schema - valid endpoints');
const validAPI = {
  endpoints: [
    { method: 'GET', path: '/users', description: 'List all users' },
    { method: 'POST', path: '/users', description: 'Create a new user' },
  ],
};
const result6 = validateStructured(validAPI, 'api_schema');
console.assert(result6.valid === true, 'Should accept valid API schema');
console.assert(result6.parsed.endpoints.length === 2, 'Should parse endpoints array');

console.log('[TEST] api_schema - path missing leading slash');
const badPath = {
  endpoints: [{ method: 'GET', path: 'users', description: 'No slash' }],
};
const result7 = validateStructured(badPath, 'api_schema');
console.assert(result7.valid === false, 'Should require paths to start with /');

console.log('[TEST] api_schema - invalid HTTP method');
const badMethod = {
  endpoints: [{ method: 'INVALID', path: '/users', description: 'Bad method' }],
};
const result8 = validateStructured(badMethod, 'api_schema');
console.assert(result8.valid === false, 'Should reject invalid HTTP method');

console.log('[TEST] api_schema - empty description');
const noDescription = {
  endpoints: [{ method: 'GET', path: '/users', description: '' }],
};
const result9 = validateStructured(noDescription, 'api_schema');
console.assert(result9.valid === false, 'Should require non-empty description');

// ─────────────────────────────────────────────────────────────────────────────
// Test: code_output validation
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[TEST] code_output - valid code with explanation');
const validCode = {
  language: 'javascript',
  code: 'const add = (a, b) => a + b; console.log(add(2, 3));',
  explanation: 'A simple arrow function',
};
const result10 = validateStructured(validCode, 'code_output');
console.assert(result10.valid === true, 'Should accept valid code output');

console.log('[TEST] code_output - code too short');
const shortCode = {
  language: 'javascript',
  code: 'x++',
  explanation: 'Too short',
};
const result11 = validateStructured(shortCode, 'code_output');
console.assert(result11.valid === false, 'Should reject code < 10 characters');

console.log('[TEST] code_output - missing language');
const noLanguage = {
  code: 'const x = 1;'.padEnd(20),
};
const result12 = validateStructured(noLanguage, 'code_output');
console.assert(result12.valid === false, 'Should require language field');

// ─────────────────────────────────────────────────────────────────────────────
// Test: component_structure validation
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[TEST] component_structure - valid component');
const validComponent = {
  name: 'Button',
  props: ['label', 'onClick', 'disabled'],
  dependencies: ['react'],
};
const result13 = validateStructured(validComponent, 'component_structure');
console.assert(result13.valid === true, 'Should accept valid component structure');

console.log('[TEST] component_structure - missing dependencies');
const noDeps = {
  name: 'Button',
  props: ['label'],
};
const result14 = validateStructured(noDeps, 'component_structure');
console.assert(result14.valid === false, 'Should require dependencies field');

// ─────────────────────────────────────────────────────────────────────────────
// Test: JSON parsing
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[TEST] JSON parsing - valid JSON string');
const jsonString = JSON.stringify({
  taskType: 'design',
  confidence: 0.9,
  signals: ['User requested design'],
});
const result15 = validateStructured(jsonString, 'task_classification');
console.assert(result15.valid === true, 'Should parse JSON string');

console.log('[TEST] JSON parsing - malformed JSON');
const badJSON = '{ invalid json }';
const result16 = validateStructured(badJSON, 'task_classification');
console.assert(result16.valid === false, 'Should catch JSON parse errors');
console.assert(result16.error.includes('parse'), 'Error should mention parsing');
console.assert(result16.raw === badJSON, 'Should preserve raw input');

// ─────────────────────────────────────────────────────────────────────────────
// Test: Unknown taskType (prose output allowed)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[TEST] unknown taskType - should allow any prose');
const proseResponse = 'This is just a plain text response, no structure required.';
const result17 = validateStructured(proseResponse, 'unknown_task_type');
console.assert(result17.valid === true, 'Should accept any output for unknown taskType');
console.assert(result17.parsed === proseResponse, 'Should return prose as-is');

console.log('[TEST] unknown taskType - can be any object');
const anyObject = { whatever: 'structure', is: 'fine' };
const result18 = validateStructured(anyObject, 'prose_conversation');
console.assert(result18.valid === true, 'Should accept any object for unknown taskType');

// ─────────────────────────────────────────────────────────────────────────────
// Test: needsStructuredOutput utility
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[TEST] needsStructuredOutput - registered schemas');
console.assert(needsStructuredOutput('task_classification') === true, 'Should find task_classification');
console.assert(needsStructuredOutput('api_schema') === true, 'Should find api_schema');
console.assert(needsStructuredOutput('code_output') === true, 'Should find code_output');
console.assert(needsStructuredOutput('component_structure') === true, 'Should find component_structure');

console.log('[TEST] needsStructuredOutput - unregistered types');
console.assert(needsStructuredOutput('unknown') === false, 'Should return false for unknown');
console.assert(needsStructuredOutput('prose') === false, 'Should return false for prose');

// ─────────────────────────────────────────────────────────────────────────────
// Test: getSchemaNames utility
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[TEST] getSchemaNames returns all registered schemas');
const schemaNames = getSchemaNames();
console.assert(Array.isArray(schemaNames), 'Should return an array');
console.assert(schemaNames.includes('task_classification'), 'Should include task_classification');
console.assert(schemaNames.includes('api_schema'), 'Should include api_schema');
console.assert(schemaNames.includes('code_output'), 'Should include code_output');
console.assert(schemaNames.includes('component_structure'), 'Should include component_structure');
console.assert(schemaNames.length === 4, 'Should have exactly 4 schemas');

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n✅ All tests completed!');
console.log('Run with: node --test validation/structuredOutputValidator.test.mjs');
