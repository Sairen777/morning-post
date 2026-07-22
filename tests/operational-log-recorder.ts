import type {
  OperationalLogEvent,
  OperationalLogRecorder,
} from "../src/observability/operational-log.ts";

export const discardOperationalEvent: OperationalLogRecorder = () =>
  Promise.resolve();

export function createOperationalEventCapture(): {
  events: OperationalLogEvent[];
  recordOperationalEvent: OperationalLogRecorder;
} {
  const events: OperationalLogEvent[] = [];
  return {
    events,
    recordOperationalEvent: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}
