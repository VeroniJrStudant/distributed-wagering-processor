import { Inject, Injectable } from '@nestjs/common';
import { SystemClock } from '../../domain/ids.ts';
import type { Clock } from '../../domain/ids.ts';
import type { ReadModel } from '../../application/ports.ts';
import { WagerProcessor } from '../../application/wager-processor.ts';
import { READ_MODEL } from '../../application/tokens.ts';

@Injectable()
export class PendingReferenceWorker {
  constructor(
    @Inject(READ_MODEL) private readonly reads: ReadModel,
    @Inject(WagerProcessor) private readonly processor: WagerProcessor,
    @Inject(SystemClock) private readonly clock: Clock,
  ) {}

  async run(): Promise<number> {
    const due = await this.reads.duePendingReferences(50, this.clock.now());
    for (const item of due) await this.processor.resume(item.id);
    return due.length;
  }
}
