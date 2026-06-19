export interface Scheduler {
  schedule(name: string, cron: string, handler: () => Promise<void> | void): void;
}

export class DenoCronScheduler implements Scheduler {
  schedule(name: string, cron: string, handler: () => Promise<void> | void): void {
    Deno.cron(name, cron, handler);
  }
}
