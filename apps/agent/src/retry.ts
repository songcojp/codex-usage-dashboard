const initialDelayMs = 30_000;
const maximumDelayMs = 30 * 60_000;

export class RetryBackoff {
  #delayMs = initialDelayMs;

  nextDelay(options: { authenticationFailure?: boolean } = {}): number {
    if (options.authenticationFailure) {
      this.#delayMs = maximumDelayMs;
      return maximumDelayMs;
    }
    const result = this.#delayMs;
    this.#delayMs = Math.min(maximumDelayMs, this.#delayMs * 2);
    return result;
  }

  reset(): void {
    this.#delayMs = initialDelayMs;
  }
}
