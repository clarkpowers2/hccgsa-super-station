export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  AI: Ai;
  ENVIRONMENT: string;
  JWT_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
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
