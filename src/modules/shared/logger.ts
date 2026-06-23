import { ConsoleLogger, LogLevel } from "@nestjs/common";

export class Logger extends ConsoleLogger {
  constructor() {
    const isProd = process.env.NODE_ENV === "production";
    const logLevels: LogLevel[] = isProd
      ? ["error", "warn", "log"]
      : ["error", "warn", "log", "debug", "verbose"];
    super("AIManager", { logLevels });
  }
}
