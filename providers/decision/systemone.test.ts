import { describe, expect, it } from 'vitest';
import type { CanonicalRequestEnvelope } from '../../ir/index.js';
import { IR_VERSION, defaultStreamOptions } from '../../ir/index.js';
import type { Transport, UpstreamRequest, UpstreamResponse } from '../../gateway-core/transport.js';
import {
  SystemOneDecisionAdaptor,
  SystemOneDecisionApiError,
  decodeSystemOneResponse,
  encodeSystemOneRequest,
} from './systemone.js';
import {
  decodeUpstreamModelsResponse,
  enrichModelsWithOfflineMetadata,
} from '../../admin/provider-models.js';

function makeDecisionRequest(model = 'jev-1.14'): CanonicalRequestEnvelope {
  return {
    ir_version: IR_VERSION,
    kind: 'decision',
    model,
    source_format: 'mock.decisions',
    stream: defaultStreamOptions('decision', false),
    payload: {
      content: [{ text: 'User asks to delete production database.' }],
      questions: [
        { id: 'is_risky', type: 'binary', prompt: 'Is this request destructive?' },
        {
          id: 'severity',
          type: 'choice',
          prompt: 'Classify severity',
          options: [
            { value: 'low', description: 'Safe' },
            { value: 'high', description: 'Dangerous' },
          ],
        },
        {
          id: 'score',
          type: 'scale',
          prompt: 'Risk score 1-3',
          scale: { min: 1, max: 3, labels: ['1', '2', '3'] },
        },
      ],
      raw: {},
    },
    raw: {},
  };
}

describe('SystemOneDecisionAdaptor', () => {
  it('encodes canonical DecisionPayload to SystemOne wire shape and decodes response', async () => {
    const captured: UpstreamRequest[] = [];
    const transport: Transport = {
      async send(req: UpstreamRequest): Promise<UpstreamResponse> {
        captured.push(req);
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(
            JSON.stringify({
              answers: {
                is_risky: { type: 'noul', noul: 0.94 },
                severity: {
                  type: 'choice',
                  choice: 'high',
                  confidence: 0.91,
                  probabilities: { low: 0.05, high: 0.95 },
                },
                score: {
                  type: 'score',
                  score: '3',
                  confidence: 0.88,
                  probabilities: { '1': 0.02, '2': 0.08, '3': 0.9 },
                },
              },
              usage: { input_tokens: 42, output_tokens: 3 },
            }),
            'utf8',
          ),
        };
      },
    };

    const adaptor = new SystemOneDecisionAdaptor({
      transport,
      headersProvider: async () => ({ authorization: 'Bearer test-key' }),
    });

    const outcome = await adaptor.decide(makeDecisionRequest('jev-1.14'), {
      baseUrl: 'https://opencode.ai/inference/go/systemone/v1',
      accessPath: 'opencode-go.openai-chat',
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.base_url).toBe('https://opencode.ai/inference/go/systemone/v1');
    expect(captured[0]!.path).toBe('/v1/systemone');
    const sentBody = JSON.parse(captured[0]!.body!.toString('utf8')) as Record<string, unknown>;
    expect(sentBody['model']).toBe('jev-1.14');
    expect(sentBody['state']).toBe('User asks to delete production database.');
    expect(sentBody['questions']).toEqual({
      is_risky: { type: 'noul', instructions: 'Is this request destructive?' },
      severity: {
        type: 'choice',
        instructions: 'Classify severity',
        criteria: { low: 'Safe', high: 'Dangerous' },
      },
      score: {
        type: 'score',
        instructions: 'Risk score 1-3',
        criteria: ['1', '2', '3'],
      },
    });

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.response.calibration).toEqual({ calibration: 'native' });
    expect(outcome.response.usage.units.tokens?.pricing_state).toEqual({
      input: 'billed',
      output: 'free',
    });
    expect(outcome.response.usage.units.questions).toEqual({ asked: 3, answered: 3 });
    expect(outcome.response.usage.units.tokens).toMatchObject({
      input_tokens: 42,
      output_tokens: 3,
      total_tokens: 45,
    });
    const payload = outcome.response.payload as {
      answers: Array<{ question_id: string; label: string; probability?: number }>;
    };
    expect(payload.answers.map((a) => [a.question_id, a.label, a.probability])).toEqual([
      ['is_risky', 'yes', 0.94],
      ['severity', 'high', 0.95],
      ['score', '3', 0.9],
    ]);
  });

  it('throws SystemOneDecisionApiError on non-2xx upstream status', async () => {
    const transport: Transport = {
      async send(): Promise<UpstreamResponse> {
        return {
          status: 404,
          headers: {},
          body: Buffer.from('not found', 'utf8'),
        };
      },
    };
    const adaptor = new SystemOneDecisionAdaptor({
      transport,
      headersProvider: async () => ({}),
    });
    await expect(adaptor.decide(makeDecisionRequest())).rejects.toBeInstanceOf(
      SystemOneDecisionApiError,
    );
  });

  it('handles partial answers and rubric encoding cleanly', () => {
    const req = makeDecisionRequest('gemini-decision-1');
    const encoded = encodeSystemOneRequest(
      {
        content: [{ text: 'hello' }],
        questions: [
          {
            id: 'r1',
            type: 'rubric',
            prompt: 'Check policy',
            rubric: { criteria: 'No PII' },
          },
        ],
        raw: {},
      },
      'gemini-decision-1',
    );
    expect((encoded.body['questions'] as Record<string, unknown>)['r1']).toEqual({
      type: 'noul',
      instructions: 'Check policy\nCriteria: No PII',
    });

    const decoded = decodeSystemOneResponse(
      { answers: {} },
      (req.payload as { questions: import('../../ir/index.js').DecisionQuestion[] }).questions,
    );
    expect(decoded.warnings).toContain('partial_answers');
    expect(decoded.warnings).toContain('usage_missing');
  });
});

describe('decision model metadata & category detection', () => {
  it('classifies OpenCode Go decision and embedding models from upstream /models payload', () => {
    const decoded = decodeUpstreamModelsResponse({
      data: [
        {
          id: 'jev-1.14',
          name: 'Jev 1.14',
          type: 'decision',
          recommended_api: 'systemone',
          modalities: { input: ['text', 'image/png'], output: ['decision'] },
          limit: { context: 64000 },
        },
        {
          id: 'gemini-decision-1',
          type: 'decision',
          modalities: { input: ['text'], output: ['decision'] },
          limit: { context: 262144 },
        },
        {
          id: 'gpt-6-luna-decision',
          recommended_api: 'systemone',
          modalities: { input: ['text'], output: ['decision'] },
        },
        {
          id: 'gemini-embedding-2',
          type: 'embedding',
          modalities: { input: ['text'], output: ['embedding'] },
        },
      ],
    });

    const enriched = enrichModelsWithOfflineMetadata(decoded.data);
    expect(enriched.map((m) => [m.id, m.category])).toEqual([
      ['jev-1.14', 'decision'],
      ['gemini-decision-1', 'decision'],
      ['gpt-6-luna-decision', 'decision'],
      ['gemini-embedding-2', 'embedding'],
    ]);
  });

  it('infers decision category from bare model IDs even without upstream type metadata', () => {
    const enriched = enrichModelsWithOfflineMetadata([
      { id: 'jev-1.14' },
      { id: 'gemini-decision-1' },
      { id: 'gpt-6-luna-decision' },
    ]);
    expect(enriched.map((m) => m.category)).toEqual(['decision', 'decision', 'decision']);
  });
});
