/**
 * Локальные ключи — тот же .env, что у всего wb-kit. Запись — тем же способом,
 * что `npm run set-key` (строка заменяется, остальные не трогаются).
 * В облаке эту роль играет Supabase Vault.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ENV_PATH, ROOT } from "../../mcp/wb/src/env.js";
import { setKey } from "../../scripts/set-key.js";
import type { SecretName, SecretStatus, SecretStore } from "../core/ports.js";

export const SECRET_NAMES: SecretName[] = ["WB_API_TOKEN", "MPSTATS_TOKEN", "ANTHROPIC_API_KEY"];

/** Пустое значение и шаблон из .env.example — «ключа нет» (как readKey в mcp/wb). */
function clean(v: string | undefined): string | undefined {
  const s = v?.trim().replace(/^[«"']|[»"']$/g, "").replace(/^Bearer\s+/i, "").trim();
  if (!s || /^(your_|ваш|вставьте|paste)/i.test(s)) return undefined;
  return s;
}

export class EnvSecretStore implements SecretStore {
  constructor(private readonly file = ENV_PATH) {}

  /** Читаем файл каждый раз: ключ могли сменить через `npm run set-key`, пока офис открыт. */
  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    return parseEnv(readFileSync(this.file, "utf8").replace(/^﻿/, "")) as Record<string, string>;
  }

  get(name: SecretName): string | undefined {
    return clean(this.read()[name]) ?? clean(process.env[name]);
  }

  set(name: SecretName, value: string): void {
    const v = value.trim();
    if (!SECRET_NAMES.includes(name)) throw new Error(`Неизвестный ключ: ${name}`);
    if (!v || /\s/.test(v)) throw new Error("Значение ключа пустое или содержит пробелы — скопируйте ключ заново.");
    if (!existsSync(this.file)) {
      const example = join(ROOT, ".env.example");
      if (existsSync(example)) copyFileSync(example, this.file);
      else writeFileSync(this.file, "");
    }
    writeFileSync(this.file, setKey(readFileSync(this.file, "utf8"), name, v));
  }

  status(): SecretStatus[] {
    return SECRET_NAMES.map((name) => {
      const v = this.get(name);
      return { name, present: Boolean(v), length: v ? v.length : null };
    });
  }
}
