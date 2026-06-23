import { defineConfig } from "vitest/config";

/**
 * Юнит-тесты ядра инстанцируют сервисы напрямую с фейками (без Nest DI-контейнера),
 * поэтому reflect-metadata / emitDecoratorMetadata не нужны — esbuild-транспиляции
 * декораторов достаточно. Тесты лежат рядом с кодом как `*.spec.ts`.
 */
export default defineConfig({
  esbuild: {
    target: "es2021",
  },
  test: {
    // globals выключены намеренно: spec'и импортируют describe/it/expect/vi из "vitest",
    // чтобы `tsc --noEmit` (typecheck включает src/**/*.ts) видел типы без правки tsconfig.types.
    globals: false,
    environment: "node",
    include: ["src/**/*.spec.ts"],
    clearMocks: true,
  },
});
