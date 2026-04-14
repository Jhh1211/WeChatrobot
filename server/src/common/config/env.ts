import "dotenv/config";
import { z } from "zod";

const isTest = process.env.NODE_ENV === "test";

if (isTest) {
  const t = (k: string, v: string) => {
    const cur = process.env[k];
    if (cur === undefined || cur === null || String(cur).trim() === "") {
      process.env[k] = v;
    }
  };
  t("LLM_BASE_URL", "http://localhost:11434");
  t("LLM_API_KEY", "test-key");
  t("LLM_MODEL", "test-model");
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://postgres:postgres@localhost:5432/wework_ai_assistant?schema=public"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  ADMIN_TOKEN: z.string().min(1).default("change_me_admin_token"),
  /** 后台登录用户名（浏览器登录，非 Bearer） */
  ADMIN_USERNAME: z.string().min(1).default("admin"),
  /** 后台登录密码；生产环境务必通过环境变量覆盖 */
  ADMIN_PASSWORD: z.string().min(1).default("Gft.5588"),
  /** 可选：签名管理端 Session Cookie；默认派生自 ADMIN_TOKEN */
  ADMIN_SESSION_SECRET: z.string().optional(),
  EXECUTOR_SHARED_TOKEN: z.string().min(1).default("change_me_executor_token"),
  DEFAULT_ROBOT_ID: z.string().min(1).default("default_robot"),
  LLM_PROVIDER: z.string().default("openai_compatible"),
  /** 当 RuntimeConfig 数据库行中对应字段为空时的兜底（后台「运行配置」优先） */
  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().min(1).default("mock_key"),
  LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  /** 方舟联网 Bot：DB 未填时的默认 Base（须以 /bots 结尾，代码会请求 /chat/completions） */
  ARK_BOT_BASE_URL: z.string().url().default("https://ark.cn-beijing.volces.com/api/v3/bots"),
  ARK_BOT_MODEL: z.string().optional().or(z.literal("")),
  /** 可与 LLM_API_KEY 相同；未设置则回退 LLM_API_KEY */
  ARK_BOT_API_KEY: z.string().optional().or(z.literal("")),
  EMBEDDING_BASE_URL: z.string().url().optional().or(z.literal("")),
  EMBEDDING_API_KEY: z.string().optional().or(z.literal("")),
  EMBEDDING_MODEL: z.string().optional().or(z.literal("")),
  DEFAULT_REPLY_THRESHOLD: z.coerce.number().default(50),
  DEFAULT_GROUP_COOLDOWN_SECONDS: z.coerce.number().default(180),
  DEFAULT_SILENCE_THRESHOLD_SECONDS: z.coerce.number().default(600),
  DEFAULT_MAX_ROBOT_MESSAGES_PER_HOUR: z.coerce.number().default(8),
  /** 同群连发聚合窗口（毫秒），默认 4000，建议 3000~5000 */
  REPLY_BURST_WINDOW_MS: z.coerce.number().min(500).max(30_000).default(4000),
  /** 聚合时附带的「上文」条数（不含最后一条问题），默认 3 */
  REPLY_BURST_CONTEXT_LINES: z.coerce.number().min(0).max(10).default(3),
  /** 入站与近期成功出站全文一致时视为回声，按己方消息处理（不聚合 burst） */
  INBOUND_ECHO_SUPPRESS_ENABLED: z
    .preprocess(
      (v) => (v === "" || v === undefined ? "true" : String(v)),
      z.string()
    )
    .transform((s) => !["false", "0", "no", "off"].includes(s.trim().toLowerCase())),
  /** 回声回查时间窗（分钟） */
  INBOUND_ECHO_LOOKBACK_MINUTES: z.coerce.number().min(1).max(1440).default(15),
  /** 每个群最多比对最近几条成功出站 */
  INBOUND_ECHO_MAX_OUTBOUNDS: z.coerce.number().min(1).max(50).default(8),
  /** 为 true 时仅当发言人名为空才认定为回声（更严，减少用户复制话术误伤） */
  INBOUND_ECHO_REQUIRE_BLANK_SENDER: z
    .preprocess(
      (v) => (v === "" || v === undefined ? "false" : String(v)),
      z.string()
    )
    .transform((s) => ["true", "1", "yes", "on"].includes(s.trim().toLowerCase())),
  /** 入站去 @ 后与出站「包含」或 Dice 比对时的最短长度门槛，过短不误判 */
  INBOUND_ECHO_CONTAIN_MIN_CHARS: z.coerce.number().min(12).max(300).default(36),
  /** 去 @ 规范化后双字 Dice ≥ 此值且两串均达 MIN_CHARS 则视为复述近期出站 */
  INBOUND_ECHO_DICE_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.86),
  /** 同群同规范化正文在 N 秒内重复入站视为重复（0 关闭） */
  INBOUND_SHORT_DEDUPE_SECONDS: z.coerce.number().min(0).max(300).default(45),
  /** 同群已存在相同正文出站（pending～success）且在 N 毫秒内则不再创建第二条 */
  OUTBOUND_CONTENT_DEDUPE_MS: z.coerce.number().min(0).max(600_000).default(120_000),
  /**
   * 是否在执行器任务 payload 中附带 mention 字段（依赖 Android 端 @ 弹窗流程）。
   * 环境变量为 false/0/no/off 时关闭；未设置或其它值视为开启。
   */
  EXECUTOR_MENTION_UI_ENABLED: z
    .preprocess(
      (v) => (v === "" || v === undefined ? "true" : String(v)),
      z.string()
    )
    .transform((s) => !["false", "0", "no", "off"].includes(s.trim().toLowerCase()))
});

export const env = envSchema.parse(process.env);
