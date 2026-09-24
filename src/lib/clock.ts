/** Injectable clock so tests can move time (reservation expiry). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  constructor(private current = new Date("2026-01-15T12:00:00Z")) {}
  now() {
    return new Date(this.current);
  }
  advanceMinutes(minutes: number) {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}

export const iso = (d: Date) => d.toISOString();
