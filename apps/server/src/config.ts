import { z } from "zod";

const serverConfigSchema = z
  .object({
    DATABASE_URL: z
      .string()
      .url()
      .default("postgres://gameish:gameish@localhost:5432/gameish"),
    HOST: z.string().min(1).default("127.0.0.1"),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("production"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(2567),
    PUBLIC_GAME_SERVER_ADDRESS: z
      .string()
      .regex(/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/.*)?$/)
      .optional(),
    PUBLIC_ORIGIN: z.string().url().optional(),
    DEVELOPMENT_LOGIN_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === "production" && config.DEVELOPMENT_LOGIN_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["DEVELOPMENT_LOGIN_ENABLED"],
        message: "Development login cannot be enabled in production",
      });
    }
  });

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export function parseServerConfig(
  environment: NodeJS.ProcessEnv,
): ServerConfig {
  return serverConfigSchema.parse(environment);
}
