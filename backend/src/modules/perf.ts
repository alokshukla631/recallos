/**
 * Performance timing for the RecallOS pipeline.
 *
 * Tracks named stages (extraction, reconciliation, context compilation, etc.)
 * and produces a timing breakdown that can be returned in API responses.
 */

export interface StageTiming {
  stage: string;
  duration_ms: number;
}

export interface PipelineTiming {
  total_ms: number;
  stages: StageTiming[];
}

export class PerfTimer {
  private start: number;
  private stages: StageTiming[] = [];
  private current: { stage: string; startMs: number } | null = null;

  constructor() {
    this.start = performance.now();
  }

  /** Begin timing a named stage. Ends any previously open stage. */
  begin(stage: string): void {
    if (this.current) {
      this.endCurrent();
    }
    this.current = { stage, startMs: performance.now() };
  }

  /** End the current stage and record its duration. */
  end(): void {
    if (this.current) {
      this.endCurrent();
    }
  }

  /** Get the full timing breakdown. */
  finish(): PipelineTiming {
    this.end(); // close any open stage
    return {
      total_ms: Math.round(performance.now() - this.start),
      stages: this.stages,
    };
  }

  private endCurrent(): void {
    if (!this.current) return;
    const duration = performance.now() - this.current.startMs;
    this.stages.push({
      stage: this.current.stage,
      duration_ms: Math.round(duration),
    });
    this.current = null;
  }
}
