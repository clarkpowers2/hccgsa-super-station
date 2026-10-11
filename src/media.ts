import type { Env } from "./types";
import { presignUrl } from "./presign";

export type MediaKind = "video" | "audio" | "thumbnail";

interface KindPolicy {
  column: "video_key" | "audio_key" | "thumbnail_key";
  maxBytes: number;
  types: Record<string, string>; // content-type -> file extension
}

const MB = 1024 * 1024;

export const MEDIA_POLICY: Record<MediaKind, KindPolicy> = {
  video: {
    column: "video_key",
    maxBytes: 2048 * MB,
    types: { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" },
  },
  audio: {
    column: "audio_key",
    maxBytes: 500 * MB,
    types: {
      "audio/mpeg": "mp3",
      "audio/mp4": "m4a",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/webm": "webm",
      "audio/ogg": "ogg",
    },
  },
  thumbnail: {
    column: "thumbnail_key",
    maxBytes: 5 * MB,
    types: { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" },
  },
};

export const isMediaKind = (v: unknown): v is MediaKind =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(MEDIA_POLICY, v);

export const keyPrefix = (networkId: string, creatorId: string, episodeId: string, kind: MediaKind) =>
  `networks/${networkId}/${creatorId}/${episodeId}/${kind}/`;

export const UPLOAD_URL_TTL_SECONDS = 60 * 60 // large videos need time to upload;
export const VIEW_URL_TTL_SECONDS = 60 * 60;

function r2Config(env: Env) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) return null;
  return {
    host: `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket: R2_BUCKET_NAME,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  };
}

export const r2Configured = (env: Env) => r2Config(env) !== null;

/** Presigned PUT. The client must send the exact Content-Type it declared. */
export async function signedUploadUrl(env: Env, key: string, contentType: string, now?: Date) {
  const cfg = r2Config(env);
  if (!cfg) throw new Error("R2 credentials not configured");
  return presignUrl({
    method: "PUT",
    host: cfg.host,
    path: `/${cfg.bucket}/${key}`,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: "auto",
    expiresSeconds: UPLOAD_URL_TTL_SECONDS,
    signedHeaders: { "content-type": contentType },
    now,
  });
}

export async function signedViewUrl(env: Env, key: string, ttl = VIEW_URL_TTL_SECONDS, now?: Date) {
  const cfg = r2Config(env);
  if (!cfg) return null;
  return presignUrl({
    method: "GET",
    host: cfg.host,
    path: `/${cfg.bucket}/${key}`,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: "auto",
    expiresSeconds: ttl,
    now,
  });
}
