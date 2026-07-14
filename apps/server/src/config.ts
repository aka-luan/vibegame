import { z } from "zod";

const serverConfigSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .default("postgres://gameish:gameish@localhost:5432/gameish"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(2567),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export function parseServerConfig(
  environment: NodeJS.ProcessEnv,
): ServerConfig {
  return serverConfigSchema.parse(environment);
}
