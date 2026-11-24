import { describe, it, expect } from "vitest";
import { findChat, tgEscape, type TgUpdate } from "./telegram.js";
import { setKey } from "./set-key.js";

const msg = (id: number, type: string, date: number): TgUpdate => ({ update_id: date, message: { chat: { id, type, first_name: "Айбек" }, date } });

describe("Telegram", () => {
  it("берёт последний личный чат, группы пропускает", () => {
    expect(findChat([msg(1, "private", 10), msg(-5, "group", 30), msg(2, "private", 20)])).toEqual({ id: 2, name: "Айбек" });
    expect(findChat([msg(-5, "group", 30)])).toBeUndefined();
    expect(findChat([])).toBeUndefined();
  });

  it("экранирует HTML для Telegram", () => {
    expect(tgEscape("Плед <бежевый> & кружка")).toBe("Плед &lt;бежевый&gt; &amp; кружка");
  });

  it("ID чата пишется в .env одной строкой, дубликаты убираются", () => {
    const env = "WB_API_TOKEN=x\nTELEGRAM_CHAT_ID=\nTELEGRAM_CHAT_ID=\n";
    expect(setKey(env, "TELEGRAM_CHAT_ID", "123")).toBe("WB_API_TOKEN=x\nTELEGRAM_CHAT_ID=123\n");
  });
});
