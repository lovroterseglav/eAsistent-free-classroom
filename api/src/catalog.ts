import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const TOKEN_PATTERN = /^[a-f0-9]{40}$/;

export const INITIAL_SCHOOLS = [
  { token: "56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33", name: "Gimnazija Kranj" },
  { token: "2f03ef5de7536804b07afbffc263a33d65af35c0", name: "Osnovna šola Antona Ukmarja Koper" },
  { token: "14f05e42fa365dc9649ce3d2cdf56fbaf6b32b4f", name: "Osnovna šola Center" },
  { token: "1f2b48c1b39236899435a3624138878cd5d826c6", name: "Osnovna šola Čepovan" },
  { token: "ae6546d36e50262b8557eba15303aeed947d663c", name: "Osnovna šola Dušana Flisa Hoče" },
  { token: "46e2748a3d3ed5400ebbdad694ef36073eaa2832", name: "Osnovna šola Jožeta Moškriča Ljubljana" },
  { token: "f54bd5135aa9f3ce3f8755f4ebdf8dd608fc596a", name: "Osnovna šola Lava Celje" },
  { token: "d8c031c6455bccd3f7dde5f94b1aa541e892c001", name: "Osnovna šola Lucija" },
  { token: "9f92f62a620b872155b2abe2b96a94111c93995f", name: "Osnovna šola Milojke Štrukelj Nova Gorica" },
  { token: "5dd8df2c1a1a7e3f78fc948150be030e7bc1a0bd", name: "Osnovna šola Miška Kranjca Ljubljana" },
  { token: "6cec1af02a33972cd9d11d5feb34ac70e690377c", name: "Osnovna šola Raka" },
  { token: "3b7d77bde3c96214bbe98428e79c64fab242c4a7", name: "Osnovna šola Srečka Kosovela Sežana" },
  { token: "3be79be35a50238f05efc1b9a0465bb655e06589", name: "Osnovna šola Štore" },
  { token: "7e40ec558fe336c35a07a91ba6e78bc638fd9080", name: "Osnovna šola Zalog" },
  { token: "7721e2fa758aeff2da5ab24956948b0806b913b6", name: "Srednja šola Jesenice" },
  { token: "250363fbd15a5a588225b12e7bfb6f8b1a5d432f", name: "Srednja zdravstvena šola Ljubljana" },
  { token: "34547418f4a775945ecc88dbb313511498e19e75", name: "Šolski center Novo mesto - Srednja zdravstvena in kemijska šola" },
] as const satisfies readonly CatalogSchool[];

export const INITIAL_SCHOOL = INITIAL_SCHOOLS[0];

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

  static memory(schools: readonly CatalogSchool[] = INITIAL_SCHOOLS): SchoolCatalog {
    return new SchoolCatalog(validSchools([...schools]));
  }

  static async open(filePath: string): Promise<SchoolCatalog> {
    let storedSchools: CatalogSchool[];
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      storedSchools = parseCatalogFile(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await preserveCorruptFile(filePath);
      }
      const catalog = new SchoolCatalog([...INITIAL_SCHOOLS], filePath);
      await catalog.persist();
      return catalog;
    }

    const catalog = new SchoolCatalog(mergeSchools(INITIAL_SCHOOLS, storedSchools), filePath);
    await catalog.persist();
    return catalog;
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

function mergeSchools(...collections: readonly (readonly CatalogSchool[])[]): CatalogSchool[] {
  const schools = new Map<string, CatalogSchool>();
  for (const collection of collections) {
    for (const school of validSchools([...collection])) schools.set(school.token, school);
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
