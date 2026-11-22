import { HOUR_MS } from '../../config/defaults.js';
import { SlimeError } from '../../shared/errors.js';

export interface GenerationLimitSettings {
  maxPerHour: number;
  maxConcurrent: number;
}

type ReleaseSlot = () => void;

/** Per instance, over a fixed hour (§7, M2 engine rules). Concurrent generations past the cap wait for a slot. */
export class GenerationLimits {
  readonly #settings: GenerationLimitSettings;
  readonly #waiting: (() => void)[] = [];
  #windowStartedAt = Date.now();
  #countInWindow = 0;
  #inFlight = 0;

  constructor(settings: GenerationLimitSettings) {
    this.#settings = settings;
  }

  get generationsThisHour(): number {
    this.#rollWindow();
    return this.#countInWindow;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  async acquire(): Promise<ReleaseSlot> {
    if (this.generationsThisHour >= this.#settings.maxPerHour) {
      throw new SlimeError('GENERATION_RATE_LIMITED', `Generation cap of ${this.#settings.maxPerHour} per hour reached.`, { retryable: true });
    }
    this.#countInWindow++;
    if (this.#inFlight >= this.#settings.maxConcurrent) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#inFlight++;
    return () => this.#release();
  }

  #release(): void {
    this.#inFlight--;
    this.#waiting.shift()?.();
  }

  #rollWindow(): void {
    if (Date.now() - this.#windowStartedAt < HOUR_MS) return;
    this.#windowStartedAt = Date.now();
    this.#countInWindow = 0;
  }
}
