import type { ChannelType } from "../dialog/dialog.types";
import type { DialogInboundJob } from "../dialog-queue/dialog-inbound-job.types";

/**
 * Контракт канала — единственная kernel-facing поверхность транспорта сообщений.
 * Раньше Telegram и WhatsApp были двумя отдельными сервисами с дублированием, а
 * воркер очереди ветвился `if (channel === "telegram") … else …`. Теперь оба
 * канала реализуют один интерфейс, а движок работает с ними полиморфно — это и есть
 * обещанные README «channel packs»: добавить канал = новая реализация ChannelAdapter,
 * зарегистрированная в ChannelRegistry, без правок воркера/диалога.
 */
export interface ChannelAdapter {
  /** Идентификатор канала (ключ маршрутизации). */
  readonly channelId: ChannelType;

  /**
   * Тяжёлый путь из воркера очереди: прогнать диалог и доставить ответ.
   * Адаптер сам разбирает свой вариант job (включая резолв бота, если нужно).
   */
  processInbound(job: DialogInboundJob): Promise<void>;

  /**
   * Низкоуровневая отправка текста получателю канала (chatId / phone / …).
   * Используется доставкой ответа и служебными уведомлениями.
   */
  sendText(recipient: string, text: string): Promise<boolean>;
}

/**
 * Реестр каналов. Чистый класс (без Nest DI) — строится из набора адаптеров там,
 * где они доступны (воркер очереди), и тривиально тестируется в изоляции.
 */
export class ChannelRegistry {
  private readonly byId = new Map<ChannelType, ChannelAdapter>();

  constructor(adapters: readonly ChannelAdapter[]) {
    for (const adapter of adapters) {
      this.byId.set(adapter.channelId, adapter);
    }
  }

  get(channelId: ChannelType): ChannelAdapter | undefined {
    return this.byId.get(channelId);
  }

  ids(): ChannelType[] {
    return [...this.byId.keys()];
  }
}
