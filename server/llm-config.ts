import { z } from "zod";
import { AppError } from "../packages/contracts/src/index.js";
import type { Database } from "./db.js";
import { decryptSecret, encryptSecret } from "./vault.js";

/**
 * Platform-level model endpoint configuration.
 *
 * Precedence: a row in `platform_settings` (written by an operator through
 * PUT /api/system/llm) wins over the process environment. The environment
 * loaded from `.env` is treated as a fallback and stays untouched, so a
 * `DELETE` restores exactly what the process started with.
 *
 * The runtime never re-reads a config file: writes apply to process.env in
 * place, which both `Agent.startJob` and `OpenAICompatibleProvider.complete`
 * read at call time. No restart is required after a change.
 */
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export const llmConfigSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .max(400)
    .default(() => process.env.LLM_BASE_URL || DEFAULT_BASE_URL),
  model: z.string().trim().min(1, "model 不能为空").max(120),
  apiKey: z.string().trim().min(8, "apiKey 至少 8 个字符").max(400),
});
export type LlmConfig = { baseUrl: string; model: string; apiKey: string };

const SETTING_KEY = "llm";
const baseline = {
  apiKey: process.env.LLM_API_KEY,
  model: process.env.LLM_MODEL,
  baseUrl: process.env.LLM_BASE_URL,
};
let source: "platform-settings" | "environment" = "environment";

export function normalizeBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AppError(400, "INVALID_LLM_BASE_URL", "模型服务地址不是合法 URL");
  }
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname))
    throw new AppError(400, "INSECURE_LLM_URL", "远程模型服务必须使用 HTTPS");
  return url.toString().replace(/\/+$/, "");
}

export function llmStatus() {
  const configured = Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL);
  return {
    configured,
    model: process.env.LLM_MODEL || null,
    baseUrl: process.env.LLM_BASE_URL || DEFAULT_BASE_URL,
    // Never echo the key: only whether one is present and where it came from.
    apiKeyPresent: Boolean(process.env.LLM_API_KEY),
    source,
  };
}

function apply(config: LlmConfig) {
  process.env.LLM_API_KEY = config.apiKey;
  process.env.LLM_MODEL = config.model;
  process.env.LLM_BASE_URL = config.baseUrl;
  source = "platform-settings";
}

function restoreBaseline() {
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  set("LLM_API_KEY", baseline.apiKey);
  set("LLM_MODEL", baseline.model);
  set("LLM_BASE_URL", baseline.baseUrl);
  source = "environment";
}

export async function readLlmConfig(
  db: Database,
  root: string,
): Promise<LlmConfig | null> {
  const row = (
    await db.query<{
      value: { baseUrl?: string; model?: string; apiKey?: string };
    }>("SELECT value FROM platform_settings WHERE key=$1", [SETTING_KEY])
  ).rows[0];
  const value = row?.value;
  if (!value?.apiKey || !value.model) return null;
  return {
    apiKey: await decryptSecret(root, value.apiKey),
    model: value.model,
    baseUrl: value.baseUrl || DEFAULT_BASE_URL,
  };
}

/** Load the stored configuration during boot; keep `.env` when nothing is stored. */
export async function bootLlmConfig(db: Database, root: string) {
  const config = await readLlmConfig(db, root).catch(() => null);
  if (config) apply(config);
  return llmStatus();
}

export async function saveLlmConfig(
  db: Database,
  root: string,
  input: unknown,
  actorId: string,
) {
  const parsed = llmConfigSchema.parse(input);
  const config: LlmConfig = {
    apiKey: parsed.apiKey,
    model: parsed.model,
    baseUrl: normalizeBaseUrl(parsed.baseUrl),
  };
  const stored = {
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: await encryptSecret(root, config.apiKey),
  };
  await db.query(
    `INSERT INTO platform_settings(key,value,updated_by,updated_at)
     VALUES($1,$2,$3,now())
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [SETTING_KEY, JSON.stringify(stored), actorId],
  );
  apply(config);
  return llmStatus();
}

export async function clearLlmConfig(db: Database) {
  await db.query("DELETE FROM platform_settings WHERE key=$1", [SETTING_KEY]);
  restoreBaseline();
  return llmStatus();
}

/**
 * One-shot connectivity probe: a single short completion against the configured
 * endpoint. Returns a diagnosis instead of throwing so the caller can show the
 * exact failure (bad key, wrong model name, blocked egress, ...).
 */
export async function probeLlm(timeoutMs = 25000) {
  const key = process.env.LLM_API_KEY,
    model = process.env.LLM_MODEL,
    baseUrl = process.env.LLM_BASE_URL || DEFAULT_BASE_URL;
  if (!key || !model)
    return {
      ok: false,
      stage: "config" as const,
      code: "LLM_UNCONFIGURED",
      message: "尚未配置 LLM_API_KEY / LLM_MODEL",
    };
  const started = Date.now();
  try {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_completion_tokens: 16,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? "凭据被拒绝"
          : response.status === 404
            ? "地址或模型名不存在"
            : response.status === 429
              ? "触发限流或额度不足"
              : "上游返回错误";
      return {
        ok: false,
        stage: "provider" as const,
        code: `HTTP_${response.status}`,
        httpStatus: response.status,
        latencyMs,
        model,
        baseUrl,
        message: `${hint}（HTTP ${response.status}）`,
      };
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      ok: true,
      stage: "done" as const,
      code: "OK",
      latencyMs,
      model,
      baseUrl,
      reply: body.choices?.[0]?.message?.content ?? "",
      usage: body.usage ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      stage: "transport" as const,
      code: (error as NodeJS.ErrnoException).name === "TimeoutError" ? "LLM_TIMEOUT" : "LLM_UNREACHABLE",
      latencyMs: Date.now() - started,
      model,
      baseUrl,
      message:
        (error as NodeJS.ErrnoException).name === "TimeoutError"
          ? `连接超时（${timeoutMs} ms）`
          : `无法连接到 ${new URL(baseUrl).host}`,
    };
  }
}

