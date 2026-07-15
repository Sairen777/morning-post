export type SchedulerHandler = () => Promise<void> | void;

export interface Scheduler {
  schedule(name: string, cron: string, handler: SchedulerHandler): void;
}

export class DenoCronScheduler implements Scheduler {
  schedule(name: string, cron: string, handler: SchedulerHandler): void {
    Deno.cron(name, cron, handler);
  }
}
