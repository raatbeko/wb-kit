/**
 * Штатное расписание офиса. id совпадает с файлом роли в .claude/agents
 * (кроме директора — это основной чат Claude Code). Новые роли
 * (finance, reports) появятся в .claude/agents на этапе 6, но в офисе
 * их места есть уже сейчас.
 */
import type { Agent } from "./types.js";

export type StaffMember = Omit<Agent, "workspaceId" | "status" | "activity" | "updatedAt">;

export const STAFF: StaffMember[] = [
  { id: "director", name: "Директор", title: "Директор", duty: "Раздаёт задачи, сводит ответы, пишет план недели", zone: "director" },
  { id: "finance", name: "Финансист", title: "Финансист", duty: "P&L, юнит-экономика, удержания WB, маржа", zone: "finance" },
  { id: "analyst", name: "Аналитик", title: "Аналитик", duty: "Продажи, выкуп, ABC, воронка карточек", zone: "analytics" },
  { id: "scout", name: "Разведчик", title: "MPSTATS-аналитик", duty: "Конкуренты, ниша, места в поиске", zone: "analytics" },
  { id: "reviews", name: "Отзывы", title: "Менеджер отзывов", duty: "Отзывы и вопросы, черновики ответов, жалобы", zone: "operations" },
  { id: "logist", name: "Логист", title: "Логист", duty: "Остатки, поставки, FBS, хранение", zone: "operations" },
  { id: "marketer", name: "Маркетолог", title: "Маркетолог", duty: "Реклама, ДРР, акции", zone: "marketing" },
  { id: "content", name: "Контент", title: "Контент-мейкер", duty: "Тексты карточек, фото и инфографика", zone: "marketing" },
  { id: "reports", name: "Отчётник", title: "Отчётник", duty: "Отчёты по запросу словами, Excel", zone: "meeting" },
];
