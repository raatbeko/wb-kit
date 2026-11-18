/**
 * Живые события на ноутбуке. Хуки Claude Code — отдельные процессы: они пишут
 * в SQLite, а не в память сервера. Поэтому подписка — это опрос таблицы
 * events по номеру seq (раз в 0,5 с — дёшево, база локальная).
 * В облаке вместо этого — Supabase Realtime.
 */
import type { EventBus, OfficeStore, Unsubscribe } from "../core/ports.js";
import type { NewEvent, OfficeEvent } from "../core/types.js";

export class LocalEventBus implements EventBus {
  constructor(
    private readonly store: OfficeStore,
    private readonly intervalMs = 500,
  ) {}

  publish(e: NewEvent): OfficeEvent {
    return this.store.addEvent(e);
  }

  subscribe(afterSeq: number, onEvent: (e: OfficeEvent) => void): Unsubscribe {
    let last = afterSeq;
    const tick = () => {
      // Ошибка чтения (база занята, повреждена, закрыта) не должна ронять весь сервер офиса.
      try {
        for (const e of this.store.listEvents(last)) {
          last = e.seq;
          onEvent(e);
        }
      } catch (err) {
        console.error("Офис: не удалось прочитать события:", err instanceof Error ? err.message : err);
      }
    };
    tick();
    const timer = setInterval(tick, this.intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
