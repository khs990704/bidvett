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
  payment_verified: z.boolean(),
  total_spend_amount: z.number().int().min(0),
  client_rating: z.number().min(0).max(5),
  risk_level: z.enum(['SAFE', 'WARNING', 'DANGER']),
  contextual_red_flags: z.array(z.string()),
  match_score: z.number().int().min(0).max(100),
  score_reason: z.string(),
  action_tip: z.string(),
});

export type AnalysisResult = z.infer<typeof AnalysisResultZod>;

export const AnalysisResultJsonSchema = {
  name: 'AnalysisResult',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'client_hire_rate',
      'payment_verified',
      'total_spend_amount',
      'client_rating',
      'risk_level',
      'contextual_red_flags',
      'match_score',
      'score_reason',
      'action_tip',
    ],
    properties: {
      client_hire_rate: { type: 'integer', minimum: 0, maximum: 100 },
      payment_verified: { type: 'boolean' },
      total_spend_amount: { type: 'integer', minimum: 0 },
      client_rating: { type: 'number', minimum: 0, maximum: 5 },
      risk_level: { type: 'string', enum: ['SAFE', 'WARNING', 'DANGER'] },
      contextual_red_flags: { type: 'array', items: { type: 'string' } },
      match_score: { type: 'integer', minimum: 0, maximum: 100 },
      score_reason: { type: 'string' },
      action_tip: { type: 'string' },
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
