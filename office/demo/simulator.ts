/**
 * Демо-режим: офис «живёт» без Claude Code и без ключей — сотрудники по
 * очереди берут задачи по демо-магазину, печатают, отчитываются, иногда
 * предлагают изменение на одобрение. Для показа клиенту и скриншотов README.
 *
 * Сцены — по проблемам из демо-снимка, поэтому цифры в ленте настоящие для
 * выдуманного магазина «Уютный дом», а не случайные.
 */
import type { OfficeStore } from "../core/ports.js";
import type { Snapshot } from "../sync/snapshot.js";
import { DEMO_PRODUCTS } from "../../audit/demo.js";

/** Цена товара демо-магазина (до скидки, ₽). */
function demoPrice(nmId: number): number {
  return DEMO_PRODUCTS.find((p) => p.nmId === nmId)?.price ?? 1000;
}

interface Beat {
  agent: string;
  steps: string[];
  done: string;
  propose?: { tool: string; title: string; changes: { item: string; before: string; after: string }[]; args: Record<string, unknown> };
}

export function buildScenario(s: Snapshot | undefined): Beat[] {
  const issue = (id: string) => s?.issues.find((i) => i.id === id);
  const first = (id: string) => issue(id)?.products[0];
  const out = first("out_of_stock");
  const low = first("low_stock");
  const drr = s?.kpis.find((k) => k.key === "drr");
  const neg = issue("negative_feedback");
  const losing = first("losing_products");
  const weak = first("weak_cards");

  const beats: Beat[] = [
    {
      agent: "director",
      steps: ["читаю утреннюю сводку", "раздаю задачи на день"],
      done: `План дня: ${s?.issues.filter((i) => i.priority === "high").length ?? 0} срочных задач, раздал сотрудникам`,
    },
    {
      agent: "logist",
      steps: ["смотрю остатки на складах WB", "считаю, на сколько дней хватит"],
      done: out ? `«${out.title}» закончился — нужна поставка` : low ? `«${low.title}» кончится скоро — пора везти` : "Остатков хватает",
    },
    {
      agent: "analyst",
      steps: ["считаю продажи", "делаю ABC-анализ", "смотрю воронку карточек"],
      done: issue("sales_drop") ? `Просели заказы: ${issue("sales_drop")!.title}` : "Продажи в норме, отчёт на столе",
    },
    {
      agent: "reviews",
      steps: ["читаю отзывы", "пишу черновики ответов"],
      done: neg ? `Частая жалоба: ${neg.title}` : "Новых негативных отзывов нет",
      propose: {
        tool: "reply_feedback",
        title: "Ответить на отзыв (демо)",
        changes: [{ item: "Отзыв ★2 «пришёл с затяжкой»", before: "без ответа", after: "«Спасибо, что написали! Заменим бесплатно — напишите в чат заказа.»" }],
        args: { id: "demo-feedback", text: "Спасибо, что написали! Заменим бесплатно — напишите в чат заказа." },
      },
    },
    {
      agent: "marketer",
      steps: ["считаю расходы на рекламу", "смотрю статистику кампаний"],
      done: drr?.value ? `ДРР ${drr.value}% — ${drr.value > 15 ? "дорого, предлагаю срезать ставки" : "в норме"}` : "Реклама в норме",
    },
    {
      agent: "finance",
      steps: ["разбираю финотчёт WB", "считаю юнит-экономику"],
      done: losing ? `«${losing.title}» в минусе после удержаний WB` : "Убыточных товаров нет",
      propose: losing
        ? {
            tool: "update_prices",
            title: `Поднять цену «${losing.title}» (демо)`,
            changes: [{ item: losing.title, before: `${demoPrice(losing.nmId)} ₽`, after: `${Math.round(demoPrice(losing.nmId) * 1.1)} ₽` }],
            // Аргументы — строго по схеме update_prices: их офис и покажет, и (в демо — условно) выполнит.
            args: { prices: [{ nmID: losing.nmId, price: Math.round(demoPrice(losing.nmId) * 1.1) }] },
          }
        : undefined,
    },
    {
      agent: "content",
      steps: ["разбираю карточку", "сравниваю с конкурентами"],
      done: weak ? `«${weak.title}»: мало фото и короткое описание — готов бриф` : "Карточки в порядке",
    },
    { agent: "scout", steps: ["смотрю данные MPSTATS", "проверяю конкурентов"], done: "Лидеры ниши не менялись, цены рынка в отчёте" },
    { agent: "reports", steps: ["собираю отчёт по запросу"], done: "Отчёт «Продажи по категориям за месяц» готов" },
  ];
  return beats;
}

/**
 * Запуск: каждые `stepMs` — следующий шаг сценария. Возвращает функцию остановки.
 * Предложения не копятся: новое — только если старых демо-одобрений не больше двух.
 */
export function startDemo(store: OfficeStore, getSnapshot: () => Snapshot | undefined, stepMs = 2500): () => void {
  let beats = buildScenario(getSnapshot());
  let i = 0;
  let step = 0;
  const tick = () => {
    // Сценарий пересобирается в начале каждой сцены: снимок демо-магазина мог появиться только что.
    if (step === 0) beats = buildScenario(getSnapshot());
    const b = beats[i]!;
    if (step === 0) {
      store.setAgentStatus(b.agent, "working", b.steps[0]);
      store.addEvent({ kind: "agent_started", agentId: b.agent, message: "Взялся за задачу", data: { demo: true } });
    }
    if (step < b.steps.length) {
      store.setAgentStatus(b.agent, "working", b.steps[step]);
      store.addEvent({ kind: "agent_step", agentId: b.agent, message: b.steps[step]![0]!.toUpperCase() + b.steps[step]!.slice(1), data: { demo: true } });
      step++;
      return;
    }
    if (b.propose && store.listApprovals({ status: "pending" }).length < 2) {
      const a = store.createApproval({ agentId: b.agent, taskId: null, ...b.propose });
      store.setAgentStatus(b.agent, "waiting", `ждёт вашего решения: ${b.propose.title}`);
      store.addEvent({ kind: "approval_requested", agentId: b.agent, message: `Предлагает: ${b.propose.title}`, data: { demo: true, approvalId: a.id } });
    } else store.setAgentStatus(b.agent, "idle");
    store.addEvent({ kind: "agent_finished", agentId: b.agent, message: `Готово: ${b.done}`, data: { demo: true } });
    step = 0;
    i = (i + 1) % beats.length;
  };
  const timer = setInterval(tick, stepMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
