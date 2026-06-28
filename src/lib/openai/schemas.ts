/**
 * OpenAI Structured Outputs JSON Schemas + matching Zod validators.
 * Source: spec/03_api_preview.md §6.1 (AnalysisResult), §6.2 (ProfileExtract).
 * _workspace/02_api_spec.md §6 mirrors these.
 *
 * Both schemas use `strict: true`. The `additionalProperties: false` and
 * full `required` list are required by OpenAI strict mode.
 */
import { z } from 'zod';

// --------------------------------------------------------------------
// AnalysisResult — analyze.v1 output
// --------------------------------------------------------------------
export const AnalysisResultZod = z.object({
  client_hire_rate: z.number().int().min(0).max(100),
  client_hire_rate_found: z.boolean(),
  payment_verified: z.boolean(),
  payment_verified_found: z.boolean(),
  total_spend_amount: z.number().int().min(0),
  total_spend_found: z.boolean(),
  client_rating: z.number().min(0).max(5),
  client_rating_found: z.boolean(),
  risk_level: z.enum(['SAFE', 'WARNING', 'DANGER']),
  contextual_red_flags: z.array(z.string()),
  match_score: z.number().int().min(0).max(100),
  score_reason: z.string(),
  action_tip: z.string(),
  evidence_quotes: z.array(z.string()),
  reasoning_bullets: z.array(z.string()),
});

export type AnalysisResult = z.infer<typeof AnalysisResultZod>;

export const AnalysisResultJsonSchema = {
  name: 'AnalysisResult',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'client_hire_rate',
      'client_hire_rate_found',
      'payment_verified',
      'payment_verified_found',
      'total_spend_amount',
      'total_spend_found',
      'client_rating',
      'client_rating_found',
      'risk_level',
      'contextual_red_flags',
      'match_score',
      'score_reason',
      'action_tip',
      'evidence_quotes',
      'reasoning_bullets',
    ],
    properties: {
      client_hire_rate: { type: 'integer', minimum: 0, maximum: 100 },
      client_hire_rate_found: { type: 'boolean' },
      payment_verified: { type: 'boolean' },
      payment_verified_found: { type: 'boolean' },
      total_spend_amount: { type: 'integer', minimum: 0 },
      total_spend_found: { type: 'boolean' },
      client_rating: { type: 'number', minimum: 0, maximum: 5 },
      client_rating_found: { type: 'boolean' },
      risk_level: { type: 'string', enum: ['SAFE', 'WARNING', 'DANGER'] },
      contextual_red_flags: { type: 'array', items: { type: 'string' } },
      match_score: { type: 'integer', minimum: 0, maximum: 100 },
      score_reason: { type: 'string' },
      action_tip: { type: 'string' },
      evidence_quotes: { type: 'array', items: { type: 'string' } },
      reasoning_bullets: { type: 'array', items: { type: 'string' } },
    },
  },
  strict: true,
} as const;

// --------------------------------------------------------------------
// ProfileExtract — profile_extract.v1 output
// --------------------------------------------------------------------
export const ProfileExtractZod = z.object({
  skills: z.array(z.string()),
  years_of_experience: z.number().int().min(0).max(60),
  target_hourly_rate: z.number().int().min(0).max(1000),
  timezone: z.string(),
});

export type ProfileExtract = z.infer<typeof ProfileExtractZod>;

export const ProfileExtractJsonSchema = {
  name: 'ProfileExtract',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['skills', 'years_of_experience', 'target_hourly_rate', 'timezone'],
    properties: {
      skills: { type: 'array', items: { type: 'string' } },
      years_of_experience: { type: 'integer', minimum: 0, maximum: 60 },
      target_hourly_rate: { type: 'integer', minimum: 0, maximum: 1000 },
      timezone: { type: 'string' },
    },
  },
  strict: true,
} as const;
