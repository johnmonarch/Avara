export interface LogEvent {
  service: string;
  level: "info" | "warn" | "error";
  event: string;
  payload?: Record<string, unknown>;
}

export function log(event: LogEvent): void {
  const record = {
    timestamp: new Date().toISOString(),
    ...event
  };

  console.log(JSON.stringify(record));
}
