import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./modules/app.module";
import { Logger } from "./modules/shared/logger";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  const logger = new Logger();

  app.useLogger(logger);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log(`API started on port ${port}`, "Bootstrap");
}

bootstrap();
