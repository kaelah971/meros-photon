import "server-only";

import {
  getActiveProvider,
  isDeepseekConfigured,
  isGeminiConfigured,
  type AiProviderId,
} from "./env";
import { getDeepseekModel } from "./deepseek";
import {
  generateSupportAnswer,
  generateJson,
  geminiStatus,
  type ChatTurn,
} from "./gemini";

export {
  getActiveProvider,
  isDeepseekConfigured,
  generateSupportAnswer,
  generateJson,
  geminiStatus,
};
export type { AiProviderId, ChatTurn };

export function aiStatus(): {
  provider: AiProviderId;
  model: string;
  configured: boolean;
} {
  const provider = getActiveProvider();
  if (provider === "deepseek") {
    return {
      provider,
      model: getDeepseekModel(),
      configured: isDeepseekConfigured(),
    };
  }
  return { provider, model: geminiStatus().model, configured: isGeminiConfigured() };
}
