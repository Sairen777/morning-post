import { Cron, type CronOptions } from "croner";
import { sanitizeErrorForOps } from "../server/error-sanitizer.ts";

export type SchedulerHandler = () => Promise<void> | void;

export interface Scheduler {
  schedule(name: string, cron: string, handler: SchedulerHandler): void;
}

export type CronFactory = (
  pattern: string,
  options: CronOptions,
  handler: SchedulerHandler,
) => Cron;

export class CronScheduler implements Scheduler {
  readonly #jobs = new Map<string, Cron>();

  constructor(
    private readonly createCron: CronFactory = (pattern, options, handler) =>
      new Cron(pattern, options, handler),
  ) {}

  schedule(name: string, cron: string, handler: SchedulerHandler): void {
    if (this.#jobs.has(name)) {
      throw new Error(`A scheduled job named "${name}" is already registered`);
    }

    const job = this.createCron(
      cron,
      {
        name,
        timezone: "UTC",
        mode: "5-part",
        protect: true,
        catch: (error: unknown) => {
          console.error(
            `Scheduled job "${name}" failed: ${sanitizeErrorForOps(error)}`,
          );
        },
      },
      handler,
    );

    this.#jobs.set(name, job);
  }

  stop(): void {
    for (const job of this.#jobs.values()) {
      job.stop();
    }
    this.#jobs.clear();
  }
}
