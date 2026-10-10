export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  AI: Ai;
  ENVIRONMENT: string;
  JWT_SECRET: string;
  CORS_ORIGINS?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string; // platform events endpoint
  STRIPE_CONNECT_WEBHOOK_SECRET: string; // connected-account events endpoint
  APP_URL: string;
  ANTHROPIC_MODEL?: string; // optional override; defaults in src/metadata.ts
  TRANSCRIBE_MAX_BYTES?: string; // optional override of the auto-transcription size cap
  ANTHROPIC_API_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
}

export interface AuthUser {
  sub: string;
  isCreator: boolean;
}

export type AppBindings = {
  Bindings: Env;
  Variables: { user: AuthUser };
};
