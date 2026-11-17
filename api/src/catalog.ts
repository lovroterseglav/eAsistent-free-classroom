import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const TOKEN_PATTERN = /^[a-f0-9]{40}$/;

export const INITIAL_SCHOOL = {
  token: "56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33",
  name: "Gimnazija Kranj",
} as const;

export interface CatalogSchool {
  token: string;
  name: string;
}

export interface PublicCatalogSchool extends CatalogSchool {
  timetableUrl: string;
}

interface CatalogFile {
  v: 1;
  schools: CatalogSchool[];
}

export function timetableUrlForToken(token: string): string {
  return `https://urniki.easistent.com/urniki/${token}`;
}

export class SchoolCatalog {
  readonly #schools = new Map<string, CatalogSchool>();
  readonly #filePath: string | undefined;
  #writeQueue = Promise.resolve();

  private constructor(schools: CatalogSchool[], filePath?: string) {
    this.#filePath = filePath;
    for (const school of schools) this.#schools.set(school.token, school);
  }

  static memory(schools: CatalogSchool[] = [INITIAL_SCHOOL]): SchoolCatalog {
    return new SchoolCatalog(validSchools(schools));
  }

  static async open(filePath: string): Promise<SchoolCatalog> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      return new SchoolCatalog(parseCatalogFile(parsed), filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await preserveCorruptFile(filePath);
      }
      const catalog = new SchoolCatalog([INITIAL_SCHOOL], filePath);
      await catalog.persist();
      return catalog;
    }
  }

  list(): PublicCatalogSchool[] {
    return [...this.#schools.values()]
      .sort((left, right) => left.name.localeCompare(right.name, "sl", { sensitivity: "base" }))
      .map((school) => ({ ...school, timetableUrl: timetableUrlForToken(school.token) }));
  }

  get(token: string): PublicCatalogSchool | undefined {
    const school = this.#schools.get(token.toLowerCase());
    return school ? { ...school, timetableUrl: timetableUrlForToken(school.token) } : undefined;
  }

  async add(token: string, name: string): Promise<boolean> {
    const school = normalizeSchool({ token, name });
    if (!school || this.#schools.has(school.token)) return false;
    this.#schools.set(school.token, school);
    await this.persist();
    return true;
  }

  async remove(token: string): Promise<boolean> {
    if (!this.#schools.delete(token.toLowerCase())) return false;
    await this.persist();
    return true;
  }

  async flush(): Promise<void> {
    await this.#writeQueue;
  }

  private async persist(): Promise<void> {
    if (!this.#filePath) return;
    this.#writeQueue = this.#writeQueue.then(async () => {
      const file: CatalogFile = { v: 1, schools: [...this.#schools.values()] };
      const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.#filePath!), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.#filePath!);
    });
    await this.#writeQueue;
  }
}

function parseCatalogFile(value: unknown): CatalogSchool[] {
  if (!value || typeof value !== "object" || (value as { v?: unknown }).v !== 1 ||
    !Array.isArray((value as { schools?: unknown }).schools)) {
    throw new Error("Invalid school catalog file");
  }
  return validSchools((value as { schools: unknown[] }).schools);
}

function validSchools(values: unknown[]): CatalogSchool[] {
  const schools = new Map<string, CatalogSchool>();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const school = normalizeSchool(value as { token?: unknown; name?: unknown });
    if (school && !schools.has(school.token)) schools.set(school.token, school);
  }
  return [...schools.values()];
}

function normalizeSchool(value: { token?: unknown; name?: unknown }): CatalogSchool | null {
  const token = String(value.token ?? "").trim().toLowerCase();
  const name = String(value.name ?? "").replace(/\s+/g, " ").trim();
  return TOKEN_PATTERN.test(token) && name ? { token, name } : null;
}

async function preserveCorruptFile(filePath: string): Promise<void> {
  try {
    await rename(filePath, `${filePath}.corrupt-${Date.now()}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
