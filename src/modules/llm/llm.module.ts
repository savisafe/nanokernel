import { Global, Module } from "@nestjs/common";
import { LlmService } from "./llm.service";
import { LLM_PROVIDER } from "./llm-provider.contract";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.provider";

/**
 * LLM_PROVIDER привязан к OpenAI-совместимому провайдеру. Чтобы подключить другой
 * транспорт (нативный Anthropic/Bedrock/локальный SDK) — поменять `useClass` здесь;
 * LlmService и весь pipeline не меняются.
 */
@Global()
@Module({
  providers: [LlmService, { provide: LLM_PROVIDER, useClass: OpenAiCompatibleProvider }],
  exports: [LlmService],
})
export class LlmModule {}
