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
    CONTROLLED_MAP_CHAT_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    MAP_INSTANCE_SOFT_POPULATION_TARGET: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(25),
    MAP_INSTANCE_HARD_CAPACITY: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(30),
    DEVELOPMENT_INSTANCE_INSPECTION_ENABLED: z
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
    if (
      config.NODE_ENV === "production" &&
      config.CONTROLLED_MAP_CHAT_ENABLED
    ) {
      context.addIssue({
        code: "custom",
        path: ["CONTROLLED_MAP_CHAT_ENABLED"],
        message: "Controlled map chat cannot be enabled in production",
      });
    }
    if (
      config.NODE_ENV === "production" &&
      config.DEVELOPMENT_INSTANCE_INSPECTION_ENABLED
    ) {
      context.addIssue({
        code: "custom",
        path: ["DEVELOPMENT_INSTANCE_INSPECTION_ENABLED"],
        message:
          "Development instance inspection cannot be enabled in production",
      });
    }
    if (
      config.MAP_INSTANCE_HARD_CAPACITY <
      config.MAP_INSTANCE_SOFT_POPULATION_TARGET
    ) {
      context.addIssue({
        code: "custom",
        path: ["MAP_INSTANCE_HARD_CAPACITY"],
        message:
          "Map instance hard capacity must be at least the soft population target",
      });
    }
  });

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export function parseServerConfig(
  environment: NodeJS.ProcessEnv,
): ServerConfig {
  return serverConfigSchema.parse(environment);
}
