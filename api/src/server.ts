import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { SchoolCatalog } from "./catalog.js";

const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "0.0.0.0";
const catalogPath = process.env.SCHOOL_CATALOG_PATH ?? resolve(process.cwd(), ".data/schools.json");
const catalog = await SchoolCatalog.open(catalogPath);
const app = await buildApp({ logger: true, catalog });

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
