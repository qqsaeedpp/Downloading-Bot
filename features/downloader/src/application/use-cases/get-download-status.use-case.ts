import type { DownloadJob } from '../../domain/entities/download-job.js';
import type { DownloadJobRepository } from '../../domain/ports/download-job.repository.js';

export interface GetDownloadStatusDependencies {
  readonly jobs: DownloadJobRepository;
}

/**
 * Read-only lookup, used by the presentation layer to refresh a card and by the
 * worker to re-check a job it is already holding.
 */
export class GetDownloadStatusUseCase {
  constructor(private readonly deps: GetDownloadStatusDependencies) {}

  async byId(jobId: string): Promise<DownloadJob | undefined> {
    return this.deps.jobs.findById(jobId);
  }

  async byShortId(shortId: string, actingUserId: string): Promise<DownloadJob | undefined> {
    const job = await this.deps.jobs.findByShortId(shortId);
    // Not "not found" versus "not yours": both answer the same, so a stranger
    // cannot probe for the existence of another user's job.
    return job?.userId === actingUserId ? job : undefined;
  }
}
