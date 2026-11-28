/**
 * Monotonic phase-locked tick clock for 60fps canvas/SVG animations.
 *
 * Instead of snapping `tick + frac` back to integer ticks on every network update
 * (which causes a visible per-tick stutter whenever `step_once` or HTTP latency varies),
 * `SmoothTickClock` tracks the actual observed tick interval and gently steers
 * `visualTick` velocity to stay phase-locked with the server without moving backward.
 */
export class SmoothTickClock {
  private visualTick = 0;
  private targetTick = 0;
  private lastServerAt = 0;
  private estPeriodMs = 1000;
  private lastFrameAt = 0;
  private initialized = false;
  private paused = false;

  sync(tick: number, tickMs: number, paused: boolean, now = performance.now()): void {
    const basePeriod = Math.max(100, tickMs || 1000);
    if (!this.initialized) {
      this.initialized = true;
      this.visualTick = tick;
      this.targetTick = tick;
      this.estPeriodMs = basePeriod;
      this.lastServerAt = now;
      this.lastFrameAt = now;
      this.paused = paused;
      return;
    }

    this.paused = paused;
    if (tick !== this.targetTick) {
      const prevTarget = this.targetTick;
      const dtServer = now - this.lastServerAt;
      const dTicks = tick - prevTarget;
      if (dTicks > 0 && dTicks <= 4 && dtServer > 50 && dtServer < basePeriod * 8) {
        const samplePeriod = dtServer / dTicks;
        this.estPeriodMs = this.estPeriodMs * 0.72 + samplePeriod * 0.28;
      } else {
        this.estPeriodMs = basePeriod;
      }
      this.targetTick = tick;
      this.lastServerAt = now;

      // Hard-resync only on world reset, backwards jump, or waking a background tab.
      if (tick < prevTarget || Math.abs(tick - this.visualTick) > 3.0) {
        this.visualTick = tick;
      }
    } else if (paused) {
      this.estPeriodMs = basePeriod;
    }
  }

  advance(now = performance.now()): number {
    if (!this.initialized) return this.visualTick;
    const dt = Math.min(100, Math.max(0, now - this.lastFrameAt));
    this.lastFrameAt = now;

    if (this.paused) {
      const err = this.targetTick - this.visualTick;
      if (Math.abs(err) < 0.002) {
        this.visualTick = this.targetTick;
      } else {
        this.visualTick += err * Math.min(1, dt / 180);
      }
      return this.visualTick;
    }

    const fracSinceServer = Math.min(1.15, Math.max(0, (now - this.lastServerAt) / this.estPeriodMs));
    const predictedServer = this.targetTick + fracSinceServer;
    const err = predictedServer - this.visualTick;
    const speedMult = Math.max(0.55, Math.min(1.65, 1.0 + err * 0.9));
    this.visualTick += (dt / this.estPeriodMs) * speedMult;
    return this.visualTick;
  }

  current(): number {
    return this.visualTick;
  }
}
