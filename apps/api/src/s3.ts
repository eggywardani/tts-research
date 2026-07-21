// Minimal S3 archival for generated audio. Modeled on audio-processor-llm's
// apps/api/src/s3.ts, trimmed to what this playground needs: upload + presign.
//
// S3 is OPTIONAL. When the required env vars are missing we treat archival as
// disabled (isS3Enabled() === false) so the experiment still runs locally with
// no AWS account — the /api/speak route falls back to streaming the wav directly.
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const BUCKET = process.env.S3_BUCKET ?? '';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID ?? '';
const SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? '';

// Archival is on only when we have a bucket + credentials to reach it.
export const isS3Enabled = (): boolean => Boolean(BUCKET && ACCESS_KEY && SECRET_KEY);

export const S3_PREFIX = { outputs: 'outputs/', speakers: 'speakers/' } as const;

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

export async function downloadFile(key: string): Promise<Buffer> {
  const res = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

export async function deleteFile(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

// Delete every object under a prefix (paginated). Returns the count removed.
export async function deletePrefix(prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const list = await s3().send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const obj of list.Contents ?? []) {
      if (obj.Key) {
        await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
        deleted++;
      }
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

// Presigned GET URL (default 1 hour) so the browser can fetch the audio directly.
export async function presignUrl(key: string, expiresIn = 3600): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}
