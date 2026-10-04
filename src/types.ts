export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  AI: Ai;
  ENVIRONMENT: string;
  JWT_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
}

export interface AuthUser {
  sub: string;
  isCreator: boolean;
}

export type AppBindings = {
  Bindings: Env;
  Variables: { user: AuthUser };
};
