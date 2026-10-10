export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  AI: Ai;
  ENVIRONMENT: string;
  JWT_SECRET: string;
  CORS_ORIGINS?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
}

export type Role = "owner" | "admin" | "creator" | "guest";

export interface AuthUser {
  sub: string;
  isCreator: boolean;
  /** Null for viewer accounts that belong to no network. */
  networkId: string | null;
  role: Role;
}

export type AppBindings = {
  Bindings: Env;
  Variables: { user: AuthUser };
};
