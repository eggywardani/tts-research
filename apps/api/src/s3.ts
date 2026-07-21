// Minimal S3 archival for generated audio. Modeled on audio-processor-llm's
// apps/api/src/s3.ts, trimmed to what this playground needs: upload + presign.
//
// S3 is OPTIONAL. When the required env vars are missing we treat archival as
// disabled (isS3Enabled() === false) so the experiment still runs locally with
// no AWS account — the /api/speak route falls back to streaming the wav directly.
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const BUCKET = process.env.S3_BUCKET ?? '';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID ?? '';
const SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? '';

// Archival is on only when we have a bucket + credentials to reach it.
export const isS3Enabled = (): boolean => Boolean(BUCKET && ACCESS_KEY && SECRET_KEY);

export const S3_PREFIX = { outputs: 'outputs/' } as const;

// Lazily built so importing this module never throws when S3 is unconfigured.
let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      region: REGION,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    });
  }
  return client;
}

export async function uploadFile(key: string, body: Buffer, contentType = 'audio/wav'): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

// Presigned GET URL (default 1 hour) so the browser can fetch the audio directly.
export async function presignUrl(key: string, expiresIn = 3600): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}
