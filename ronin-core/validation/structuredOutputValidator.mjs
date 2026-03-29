// validation/structuredOutputValidator.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Zod-based validation for structured model outputs.
//
// When a task requires a structured response (like code generation or API design),
// we validate it against a schema before returning to the client. This prevents
// garbage output from reaching the operator UI.
//
// Each taskType that needs structure has a corresponding Zod schema. Unknown
// task types are allowed to return prose (no validation).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Schema Definitions
// ─────────────────────────────────────────────────────────────────────────────

// task_classification: Router uses this to categorize a new task on intake.
// The model must tell us what kind of work this is (code? design? conversation?)
// and how confident it is, so we route to the right queue lane.
const task_classification = z.object({
  taskType: z.enum(['code', 'design', 'conversation', 'architecture', 'debug', 'bulk', 'quick']),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.string()).min(1), // at least one signal explaining the classification
});

// api_schema: When a task asks the model to design an API, we validate that
// the response includes all required endpoints with correct structure.
const api_schema = z.object({
  endpoints: z.array(
    z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
      path: z.string().startsWith('/'), // All paths must start with /
      description: z.string().min(1),  // Each endpoint must be documented
    }),
    { errorMap: () => ({ message: 'At least one endpoint is required' }) }
  ).min(1),
});

// code_output: Generated code must include the actual code string and can
// optionally include an explanation. Minimum 10 chars ensures it's not garbage.
const code_output = z.object({
  language: z.string(),
  code: z.string().min(10), // Prevent single-line "truthy" outputs
  explanation: z.string().optional(),
});

// component_structure: For design tasks, validate that a component is
// properly defined with dependencies tracked.
const component_structure = z.object({
  name: z.string(),
  props: z.array(z.string()),
  dependencies: z.array(z.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema Registry
// ─────────────────────────────────────────────────────────────────────────────
// Central map of taskType → schema. Add new schemas here as new task types
// are introduced to the system.

const SCHEMAS = {
  task_classification,
  api_schema,
  code_output,
  component_structure,
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * validateStructured(response, taskType)
 *
 * Attempts to parse and validate a model response against a Zod schema.
 *
 * Flow:
 *   1. If no schema exists for this taskType, return { valid: true, parsed: response }
 *      (prose output is always allowed)
 *   2. Try to JSON.parse the response
 *   3. If parsing fails, return { valid: false, error: "...", raw: response }
 *   4. Try to validate parsed object against schema
 *   5. If validation passes, return { valid: true, parsed: object }
 *   6. If validation fails, return { valid: false, error: "...", raw: response }
 *
 * @param {string|object} response - Model output (string or already parsed)
 * @param {string} taskType - The type of task (must match a key in SCHEMAS or no validation occurs)
 * @returns {object} - { valid: boolean, parsed?: object, error?: string, raw?: string }
 */
export function validateStructured(response, taskType) {
  // If this taskType doesn't require structured output, accept it as-is
  const schema = SCHEMAS[taskType];
  if (!schema) {
    return {
      valid: true,
      parsed: response,
    };
  }

  // Response might already be parsed (if coming from streaming), or might be a JSON string
  let parsed;
  const raw = typeof response === 'string' ? response : JSON.stringify(response);

  try {
    parsed = typeof response === 'string' ? JSON.parse(response) : response;
  } catch (parseError) {
    return {
      valid: false,
      error: `JSON parse error: ${parseError.message}`,
      raw,
    };
  }

  // Now validate against the schema
  try {
    schema.parse(parsed);
    return {
      valid: true,
      parsed,
    };
  } catch (validationError) {
    return {
      valid: false,
      error: `Schema validation failed: ${validationError.message}`,
      raw,
    };
  }
}

/**
 * needsStructuredOutput(taskType)
 *
 * Quick check: does this task type require structured validation?
 * Used by the router to decide whether to ask for JSON or prose.
 *
 * @param {string} taskType - The task type to check
 * @returns {boolean} - true if a schema exists for this type
 */
export function needsStructuredOutput(taskType) {
  return taskType in SCHEMAS;
}

/**
 * getSchemaNames()
 *
 * Returns list of all registered schema names.
 * Useful for logging, debugging, and API documentation.
 *
 * @returns {string[]} - Array of schema names
 */
export function getSchemaNames() {
  return Object.keys(SCHEMAS);
}
