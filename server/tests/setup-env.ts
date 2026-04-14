/**
 * Vitest 最先加载：确保在任意模块 import env 前补齐 LLM 占位（与 env.ts 中 NODE_ENV=test 逻辑双保险）。
 */
process.env.NODE_ENV = "test";
if (!process.env.LLM_BASE_URL?.trim()) process.env.LLM_BASE_URL = "http://localhost:11434";
if (!process.env.LLM_API_KEY?.trim()) process.env.LLM_API_KEY = "test-key";
if (!process.env.LLM_MODEL?.trim()) process.env.LLM_MODEL = "test-model";
