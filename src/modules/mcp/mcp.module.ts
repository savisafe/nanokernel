import { Global, Module } from "@nestjs/common";
import { McpClientService } from "./mcp-client.service";

/**
 * Подключение внешних скиллов по стандарту MCP. Экспортирует McpClientService,
 * который SkillsModule использует в async-фабрике SKILL_PROVIDERS_TOKEN, чтобы
 * влить MCP-инструменты в общий реестр скиллов.
 */
@Global()
@Module({
  providers: [McpClientService],
  exports: [McpClientService],
})
export class McpModule {}
