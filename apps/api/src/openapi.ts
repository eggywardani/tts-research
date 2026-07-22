// Hand-written OpenAPI 3.1 spec for the TTS API, served at /openapi.json and
// rendered by Scalar at /docs (both public). Mirrors audio-processor-llm's
// openapi.ts approach: one file, no decorators, kept in sync with the routes in
// server.ts / speakers.ts / history.ts / keys.ts by hand.
//
// Auth: every /api/* route accepts a token via `Authorization: Bearer <token>`,
// the `x-api-token` header, or `?token=`. Token-management routes (/api/keys)
// require the MASTER token; all other routes also accept a per-client token.

const bearerAuth = [{ BearerAuth: [] }, { ApiKeyHeader: [] }, { ApiKeyQuery: [] }];

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export function getOpenApiSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'OmniVoice — TTS API',
      version: '1.0.0',
      description:
        'Text-to-speech API for the OmniVoice engine with voice cloning, voice design, ' +
        'long-text chunking, an async job queue, and optional RVC post-processing.\n\n' +
        '**Auth** — send your token as `Authorization: Bearer <token>`, an `x-api-token` ' +
        'header, or `?token=<token>`. Per-client tokens reach every route except token ' +
        'management (`/api/keys`), which needs the master token.',
    },
    servers: [{ url: '/', description: 'This API service' }],
    security: bearerAuth,
    tags: [
      { name: 'TTS', description: 'Generate speech' },
      { name: 'Jobs', description: 'Async generation queue' },
      { name: 'Speakers', description: 'Saved voice library (cloning references)' },
      { name: 'History', description: 'Past generations' },
      { name: 'Engines', description: 'Engine metadata' },
      { name: 'Tokens', description: 'Per-client API tokens (master token only)' },
    ],
    paths: {
      '/api/speak': {
        post: {
          tags: ['TTS'],
          summary: 'Generate speech (blocking)',
          description:
            'Enqueue a generation and, by default, wait for it to finish and return the ' +
            'result. Pass `?async=1` to return immediately with a queued job (202) instead. ' +
            'Accepts either `application/json` or `multipart/form-data` (the latter lets you ' +
            'upload a one-off reference clip via `speaker_wav`).',
          parameters: [
            {
              name: 'async',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['1'] },
              description: 'Return 202 + job id immediately instead of blocking.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: ref('JobRequest') },
              'multipart/form-data': { schema: ref('JobRequestForm') },
            },
          },
          responses: {
            '200': { description: 'Finished job', content: { 'application/json': { schema: ref('JobView') } } },
            '202': { description: 'Queued (async=1)', content: { 'application/json': { schema: ref('JobView') } } },
            '400': { description: 'Invalid request', content: { 'application/json': { schema: ref('Error') } } },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: ref('Error') } } },
            '502': { description: 'Generation failed', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
      },
      '/api/tts/webhook': {
        post: {
          tags: ['TTS'],
          summary: 'Generate speech with webhook callbacks',
          description:
            'Like `POST /api/jobs`, but `webhook_url` is required. As the job runs the server ' +
            'POSTs status updates (`queued` → `processing` → `progress` → `completed`/`failed`) ' +
            'to that URL — retried a few times, ordered per job, no signature. Returns 202 immediately.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: ref('JobRequest') },
              'multipart/form-data': { schema: ref('JobRequestForm') },
            },
          },
          responses: {
            '202': { description: 'Queued job', content: { 'application/json': { schema: ref('JobView') } } },
            '400': { description: 'Invalid request or missing webhook_url', content: { 'application/json': { schema: ref('Error') } } },
          },
          callbacks: {
            jobStatus: {
              '{$request.body#/webhook_url}': {
                post: {
                  summary: 'Status update delivered to your webhook_url',
                  requestBody: { content: { 'application/json': { schema: ref('WebhookEvent') } } },
                  responses: { '2XX': { description: 'Any 2xx marks the delivery successful.' } },
                },
              },
            },
          },
        },
      },
      '/api/jobs': {
        post: {
          tags: ['Jobs'],
          summary: 'Enqueue a generation',
          description: 'Create a job and return immediately with a queued job (202). Poll ' +
            '`GET /api/jobs/{id}` or stream `GET /api/jobs/{id}/stream`.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: ref('JobRequest') },
              'multipart/form-data': { schema: ref('JobRequestForm') },
            },
          },
          responses: {
            '202': { description: 'Queued job', content: { 'application/json': { schema: ref('JobView') } } },
            '400': { description: 'Invalid request', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
        get: {
          tags: ['Jobs'],
          summary: 'List recent jobs',
          parameters: [
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: {
            '200': { description: 'Jobs', content: { 'application/json': { schema: { type: 'array', items: ref('JobView') } } } },
          },
        },
      },
      '/api/jobs/{id}': {
        get: {
          tags: ['Jobs'],
          summary: 'Get job status',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Job', content: { 'application/json': { schema: ref('JobView') } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
      },
      '/api/jobs/{id}/cancel': {
        post: {
          tags: ['Jobs'],
          summary: 'Cancel a job',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Cancelled', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
            '409': { description: 'Not cancellable (already finished or missing)', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
      },
      '/api/jobs/{id}/stream': {
        get: {
          tags: ['Jobs'],
          summary: 'Live progress (SSE)',
          description:
            'Server-Sent Events stream of progress for a job. Emits a `snapshot`, then ' +
            '`processing`/`start`/`chunk`/`completed`/`error`/`cancelled` events until the ' +
            'job is terminal. Each `chunk` event carries base64-encoded WAV for progressive playback.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'text/event-stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
      },
      '/api/engines': {
        get: {
          tags: ['Engines'],
          summary: 'Engine metadata',
          description: 'Proxied from the TTS service — display name, sample rate, default params, and param schema per engine.',
          responses: {
            '200': { description: 'Engines', content: { 'application/json': { schema: { type: 'object' } } } },
            '502': { description: 'TTS service unreachable', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
      },
      '/api/speakers': {
        get: {
          tags: ['Speakers'],
          summary: 'List saved voices',
          responses: {
            '200': { description: 'Speakers', content: { 'application/json': { schema: { type: 'array', items: ref('Speaker') } } } },
          },
        },
        post: {
          tags: ['Speakers'],
          summary: 'Create a voice from a reference clip',
          description: 'Multipart upload. Stores the clip in S3 + metadata in Postgres (requires S3 configured).',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['name', 'audio'],
                  properties: {
                    name: { type: 'string' },
                    language: { type: 'string', default: 'en' },
                    ref_text: { type: 'string', description: 'Optional transcript of the clip.' },
                    voice_preset: { type: 'string', description: 'Optional JSON-encoded VoicePreset.' },
                    audio: { type: 'string', format: 'binary' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Created speaker', content: { 'application/json': { schema: ref('Speaker') } } },
            '400': { description: 'Invalid request', content: { 'application/json': { schema: ref('Error') } } },
            '503': { description: 'S3 not configured', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
      },
      '/api/speakers/{id}': {
        get: {
          tags: ['Speakers'],
          summary: 'Get a voice',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Speaker', content: { 'application/json': { schema: ref('Speaker') } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
        patch: {
          tags: ['Speakers'],
          summary: 'Update voice metadata',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    language: { type: 'string' },
                    voice_preset: ref('VoicePreset'),
                    engines: { type: 'object', additionalProperties: true },
                    default_engine: { type: 'string' },
                    api_enabled: { type: 'boolean' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Updated speaker', content: { 'application/json': { schema: ref('Speaker') } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
        delete: {
          tags: ['Speakers'],
          summary: 'Delete a voice',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
      },
      '/api/history': {
        get: {
          tags: ['History'],
          summary: 'List generations',
          parameters: [
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: {
            '200': { description: 'History', content: { 'application/json': { schema: { type: 'array', items: ref('HistoryItem') } } } },
          },
        },
        delete: {
          tags: ['History'],
          summary: 'Clear all history',
          responses: {
            '200': { description: 'Cleared', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, deleted: { type: 'integer' } } } } } },
          },
        },
      },
      '/api/history/{id}': {
        get: {
          tags: ['History'],
          summary: 'Get one generation (with playback URL)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'History item', content: { 'application/json': { schema: ref('HistoryItem') } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
        delete: {
          tags: ['History'],
          summary: 'Delete one generation',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
      },
      '/api/keys': {
        get: {
          tags: ['Tokens'],
          summary: 'List API tokens (master token only)',
          responses: {
            '200': { description: 'Tokens', content: { 'application/json': { schema: { type: 'array', items: ref('ApiKey') } } } },
            '401': { description: 'Unauthorized (needs master token)', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
        post: {
          tags: ['Tokens'],
          summary: 'Create an API token (master token only)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
          },
          responses: {
            '201': { description: 'Created token (full value visible)', content: { 'application/json': { schema: ref('ApiKey') } } },
            '400': { description: 'name is required', content: { 'application/json': { schema: ref('Error') } } },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
      },
      '/api/keys/{id}/toggle': {
        post: {
          tags: ['Tokens'],
          summary: 'Enable/disable a token (master token only)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { disabled: { type: 'boolean' } } } } },
          },
          responses: {
            '200': { description: 'Toggled', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, disabled: { type: 'boolean' } } } } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
      },
      '/api/keys/{id}': {
        delete: {
          tags: ['Tokens'],
          summary: 'Revoke a token (master token only)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Revoked', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        BearerAuth: { type: 'http', scheme: 'bearer', description: 'Authorization: Bearer <token>' },
        ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'x-api-token' },
        ApiKeyQuery: { type: 'apiKey', in: 'query', name: 'token' },
      },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' }, detail: { type: 'string' } } },
        VoicePreset: {
          type: 'object',
          properties: {
            temperature: { type: 'number' },
            top_p: { type: 'number' },
            cfg_scale: { type: 'number' },
            seed: { type: 'integer' },
            use_rvc: { type: 'boolean' },
            rvc_model: { type: 'string' },
            rvc_pitch: { type: 'number' },
          },
        },
        JobRequest: {
          type: 'object',
          required: ['text'],
          description: 'Provide `speaker_id` (cloning) or `instruct` (voice design).',
          properties: {
            text: { type: 'string' },
            engine: { type: 'string', default: 'omnivoice' },
            speaker_id: { type: 'string', format: 'uuid', nullable: true, description: 'Saved voice to clone.' },
            instruct: { type: 'string', description: 'Voice-design attributes, e.g. "female, low pitch, british accent".' },
            ref_text: { type: 'string', description: 'Transcript of the reference clip (optional; auto-ASR when blank).' },
            temperature: { type: 'number', default: 0.7 },
            top_p: { type: 'number', default: 0.9 },
            cfg_scale: { type: 'number', default: 2.0 },
            seed: { type: 'integer', default: -1 },
            use_rvc: { type: 'boolean', default: false },
            rvc_model: { type: 'string' },
            rvc_pitch: { type: 'number', default: 0 },
            webhook_url: { type: 'string', format: 'uri', description: 'Optional. POST status updates here as the job runs.' },
          },
        },
        JobRequestForm: {
          type: 'object',
          description: 'Same fields as JobRequest, plus an optional one-off reference clip.',
          required: ['text'],
          properties: {
            text: { type: 'string' },
            engine: { type: 'string', default: 'omnivoice' },
            speaker_id: { type: 'string', format: 'uuid' },
            instruct: { type: 'string' },
            ref_text: { type: 'string' },
            temperature: { type: 'number' },
            top_p: { type: 'number' },
            cfg_scale: { type: 'number' },
            seed: { type: 'integer' },
            use_rvc: { type: 'boolean' },
            rvc_model: { type: 'string' },
            rvc_pitch: { type: 'number' },
            webhook_url: { type: 'string', format: 'uri' },
            speaker_wav: { type: 'string', format: 'binary', description: 'One-off reference clip (cloning without a saved voice).' },
          },
        },
        WebhookEvent: {
          type: 'object',
          description: 'Payload POSTed to your webhook_url as the job progresses. No signature — re-verify via GET /api/jobs/{id}.',
          properties: {
            event: { type: 'string', enum: ['queued', 'processing', 'progress', 'completed', 'failed', 'cancelled'] },
            job_id: { type: 'string', format: 'uuid' },
            status: { type: 'string' },
            completed_chunks: { type: 'integer', description: 'Present on `progress`.' },
            total_chunks: { type: 'integer', description: 'Present on `progress`.' },
            history_id: { type: 'string', format: 'uuid', nullable: true, description: 'Present on `completed`.' },
            url: { type: 'string', nullable: true, description: 'Presigned audio URL — present on `completed` when S3 is on.' },
            error: { type: 'string', description: 'Present on `failed`.' },
          },
        },
        JobView: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['queued', 'processing', 'completed', 'failed', 'cancelled'] },
            position: { type: 'integer', description: 'Queue position (0 = next/processing).' },
            total_chunks: { type: 'integer' },
            completed_chunks: { type: 'integer' },
            history_id: { type: 'string', format: 'uuid', nullable: true },
            url: { type: 'string', nullable: true, description: 'Presigned audio URL when S3 is configured and the job is done.' },
            error: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
            text: { type: 'string' },
            engine: { type: 'string' },
          },
        },
        Speaker: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            language: { type: 'string' },
            original_filename: { type: 'string' },
            duration_seconds: { type: 'number', nullable: true },
            default_engine: { type: 'string' },
            engines: { type: 'object', additionalProperties: true },
            voice_preset: ref('VoicePreset'),
            audio_url: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        HistoryChunk: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            text: { type: 'string' },
            status: { type: 'string', enum: ['completed', 'failed', 'silent'] },
            duration_seconds: { type: 'number', nullable: true },
          },
        },
        HistoryItem: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            speaker_id: { type: 'string', format: 'uuid', nullable: true },
            speaker_name: { type: 'string', nullable: true },
            text: { type: 'string' },
            engine: { type: 'string' },
            params: { type: 'object', additionalProperties: true },
            sample_rate: { type: 'string' },
            rvc: { type: 'boolean' },
            duration_seconds: { type: 'number', nullable: true },
            chunks: { type: 'array', items: ref('HistoryChunk') },
            has_audio: { type: 'boolean' },
            url: { type: 'string', nullable: true, description: 'Presigned URL — populated on the single-item GET only.' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        ApiKey: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            token: { type: 'string', description: 'Plaintext token — send as a Bearer/x-api-token/query value.' },
            disabled: { type: 'boolean' },
            request_count: { type: 'integer' },
            last_used_at: { type: 'string', format: 'date-time', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  };
}
