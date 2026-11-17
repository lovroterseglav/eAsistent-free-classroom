import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { SchoolCatalog } from "./catalog.js";
import { AppError, EasistentService, parsePublicTimetableUrl } from "./easistent.js";

const timetableBody = {
  type: "object",
  additionalProperties: false,
  required: ["timetableUrl"],
  properties: {
    timetableUrl: { type: "string", minLength: 1, maxLength: 500 },
  },
} as const;

const availabilityBody = {
  type: "object",
  additionalProperties: false,
  required: ["timetableUrl", "date", "period"],
  properties: {
    timetableUrl: { type: "string", minLength: 1, maxLength: 500 },
    date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    period: { type: "integer", minimum: -1, maximum: 30 },
  },
} as const;

interface AppOptions {
  service?: EasistentService;
  catalog?: SchoolCatalog;
  logger?: boolean;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: "127.0.0.1",
    bodyLimit: 8 * 1024,
  });
  const service = options.service ?? new EasistentService();
  const catalog = options.catalog ?? SchoolCatalog.memory();

  await app.register(rateLimit, {
    global: true,
    max: 30,
    timeWindow: "1 minute",
    ipv6Subnet: 64,
  });

  app.get("/api/v1/health", { config: { rateLimit: false } }, async () => ({
    ok: true,
    cache: { pages: service.pageCache.size },
  }));

  app.get("/api/v1/schools", async () => ({ v: 1, schools: catalog.list() }));

  app.post<{ Body: { timetableUrl: string } }>("/api/v1/schools/inspect", {
    schema: { body: timetableBody },
  }, async (request) => {
    const controller = requestDeadline();
    try {
      const result = (await service.inspect(request.body.timetableUrl, controller.signal)).inspection;
      await catalog.add(result.school.token, result.school.name);
      return result;
    } catch (error) {
      await removePermanentlyMissingSchool(catalog, request.body.timetableUrl, error);
      throw error;
    } finally {
      controller.abort();
    }
  });

  app.post<{ Body: { timetableUrl: string; date: string; period: number } }>("/api/v1/availability", {
    schema: { body: availabilityBody },
  }, async (request) => {
    const controller = requestDeadline();
    try {
      const result = await service.availability(request.body.timetableUrl, request.body.date, request.body.period, controller.signal);
      await catalog.add(result.school.token, result.school.name);
      return result;
    } catch (error) {
      await removePermanentlyMissingSchool(catalog, request.body.timetableUrl, error);
      throw error;
    } finally {
      controller.abort();
    }
  });

  app.addHook("onClose", async () => catalog.flush());

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ v: 1, error: { code: error.code, message: error.message } });
    }
    const fastifyError = error as { validation?: unknown; statusCode?: number };
    if (fastifyError.validation) {
      return reply.code(400).send({ v: 1, error: { code: "INVALID_REQUEST", message: "Zahteva ni veljavna." } });
    }
    if (fastifyError.statusCode === 429) {
      return reply.code(429).send({ v: 1, error: { code: "RATE_LIMITED", message: "Preveč zahtev. Poskusi znova čez minuto." } });
    }
    app.log.error(error);
    return reply.code(500).send({ v: 1, error: { code: "INTERNAL_ERROR", message: "Prišlo je do notranje napake." } });
  });

  return app;
}

async function removePermanentlyMissingSchool(catalog: SchoolCatalog, timetableUrl: string, error: unknown): Promise<void> {
  if (!(error instanceof AppError) || error.code !== "TIMETABLE_NOT_FOUND") return;
  const parsed = parsePublicTimetableUrl(timetableUrl);
  const submitted = new URL(parsed.url);
  submitted.hash = "";
  submitted.search = "";
  submitted.pathname = submitted.pathname.replace(/\/$/, "");
  const stored = catalog.get(parsed.schoolToken);
  if (stored?.timetableUrl === submitted.href) await catalog.remove(parsed.schoolToken);
}

function requestDeadline(): AbortController {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  controller.signal.addEventListener("abort", () => {
    clearTimeout(timer);
  }, { once: true });
  return controller;
}
