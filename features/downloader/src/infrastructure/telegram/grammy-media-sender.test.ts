import { DownloadType, createNoopLogger } from '@tgtools/shared';
import type { LogContext, Logger } from '@tgtools/shared';
import { GrammyError } from 'grammy';
import type { Api } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { DownloadFailureCode } from '../../domain/errors/download-failure-code.js';
import type { SendMediaCommand } from '../../domain/ports/supporting-ports.js';
import { GrammyMediaSender } from './grammy-media-sender.js';

const MB = 1024 * 1024;

/** A GrammyError with the description the classifier reads. */
function telegramError(description: string, errorCode = 400): GrammyError {
  return new GrammyError(
    `Call to 'sendVideo' failed! (${String(errorCode)}: ${description})`,
    { ok: false, error_code: errorCode, description },
    'sendVideo',
    {},
  );
}

interface Harness {
  readonly sender: GrammyMediaSender;
  readonly calls: string[];
  readonly lines: { message: string; context: LogContext | undefined }[];
  readonly api: { sendVideo: ReturnType<typeof vi.fn>; sendDocument: ReturnType<typeof vi.fn> };
}

function createHarness(
  options: {
    readonly videoFails?: GrammyError;
    readonly maxUploadBytes?: number;
    readonly statSize?: number;
  } = {},
): Harness {
  const calls: string[] = [];
  const lines: { message: string; context: LogContext | undefined }[] = [];

  const sendVideo = vi.fn(() => {
    calls.push('sendVideo');
    if (options.videoFails !== undefined) return Promise.reject(options.videoFails);
    return Promise.resolve({ message_id: 1, video: { file_id: 'vid' } });
  });
  const sendDocument = vi.fn(() => {
    calls.push('sendDocument');
    return Promise.resolve({ message_id: 2, document: { file_id: 'doc' } });
  });

  const base = createNoopLogger();
  const logger: Logger = {
    ...base,
    info: (message, context) => lines.push({ message, context }),
    warn: () => undefined,
    child: () => logger,
  };

  const api = { sendVideo, sendDocument };

  const sender = new GrammyMediaSender({
    api: api as unknown as Api,
    logger,
    uploadTimeoutMs: 5_000,
    maxUploadBytes: options.maxUploadBytes ?? 1_900 * MB,
    apiRoot: 'http://telegram-bot-api:8081',
    ...(options.statSize === undefined
      ? {}
      : { statFile: () => Promise.resolve({ size: options.statSize as number }) }),
  });

  return { sender, calls, lines, api };
}

function command(overrides: Partial<SendMediaCommand> = {}): SendMediaCommand {
  return {
    chatId: 42,
    filePath: '/tmp/job/media.mp4',
    fileName: 'media.mp4',
    mimeType: 'video/mp4',
    fileSize: 10 * MB,
    caption: 'caption',
    type: DownloadType.Video,
    video: {
      width: 1920,
      height: 1080,
      duration: 30,
      thumbnailPath: undefined,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
    },
    deliveryMode: 'direct-video',
    jobId: 'job-1',
    selectedQuality: '1080p',
    ...overrides,
  };
}

describe('GrammyMediaSender delivery mode', () => {
  it('sends a playable video as a video', async () => {
    const { sender, calls } = createHarness();
    await sender.send(command());
    expect(calls).toEqual(['sendVideo']);
  });

  it('sends a direct-document file straight to sendDocument, never trying video first', async () => {
    // The whole reason `deliveryMode` is carried. ffprobe already established
    // Telegram cannot stream this codec, so attempting sendVideo would push the
    // entire file — up to 1.9 GB — to be told what was already known, and then
    // push it a second time. One upload, not two.
    const { sender, calls } = createHarness();

    await sender.send(
      command({
        deliveryMode: 'direct-document',
        transcodeSkippedReason: 'VIDEO_FAST_DELIVERY is on',
        video: {
          width: 3840,
          height: 2160,
          duration: 300,
          thumbnailPath: undefined,
          videoCodec: 'av01',
          audioCodec: 'opus',
          container: 'webm',
        },
      }),
    );

    expect(calls).toEqual(['sendDocument']);
  });

  it('still falls back to a document when Telegram rejects the typed send', async () => {
    // The mode is decided from ffprobe, which can be wrong or absent. Telegram
    // gets the final say, and its refusal must not lose the user their file.
    const { sender, calls } = createHarness({
      videoFails: telegramError('Bad Request: unsupported message media type'),
    });

    await sender.send(command());
    expect(calls).toEqual(['sendVideo', 'sendDocument']);
  });

  it('does NOT retry as a document when the chat is gone', async () => {
    // Re-uploading every byte to a chat that does not exist learns nothing and
    // costs the whole file again.
    const { sender, calls } = createHarness({
      videoFails: telegramError('Bad Request: chat not found'),
    });

    await expect(sender.send(command())).rejects.toMatchObject({
      code: DownloadFailureCode.UploadFailed,
    });
    expect(calls).toEqual(['sendVideo']);
  });

  it('does NOT retry as a document when the bot is blocked', async () => {
    const { sender, calls } = createHarness({
      videoFails: telegramError('Forbidden: bot was blocked by the user', 403),
    });

    await expect(sender.send(command())).rejects.toBeDefined();
    expect(calls).toEqual(['sendVideo']);
  });
});

describe('GrammyMediaSender size guards', () => {
  it('refuses a file over the configured ceiling before uploading anything', async () => {
    const { sender, calls } = createHarness({ maxUploadBytes: 1_900 * MB });

    await expect(sender.send(command({ fileSize: 1_950 * MB }))).rejects.toMatchObject({
      code: DownloadFailureCode.MediaTooLarge,
    });
    expect(calls).toEqual([]);
  });

  it('accepts a file just under the 1900 MB local-server ceiling', async () => {
    // The number that matters after enabling a local Bot API server: the point
    // of the whole feature is that this no longer fails.
    const { sender, calls } = createHarness({ maxUploadBytes: 1_900 * MB });
    await sender.send(command({ fileSize: 1_899 * MB }));
    expect(calls).toEqual(['sendVideo']);
  });

  it('believes the disk over the caller when the two disagree', async () => {
    // A file truncated or swept between finalisation and upload. Failing here
    // with a reason beats an opaque Telegram rejection.
    const { sender, calls } = createHarness({
      maxUploadBytes: 100 * MB,
      statSize: 500 * MB,
    });

    await expect(sender.send(command({ fileSize: 10 * MB }))).rejects.toMatchObject({
      code: DownloadFailureCode.MediaTooLarge,
    });
    expect(calls).toEqual([]);
  });

  it('refuses a zero-byte file rather than uploading nothing', async () => {
    const { sender, calls } = createHarness({ statSize: 0 });

    await expect(sender.send(command())).rejects.toMatchObject({
      code: DownloadFailureCode.ProcessingFailed,
    });
    expect(calls).toEqual([]);
  });
});

describe('GrammyMediaSender delivery log', () => {
  it('records everything needed to explain the delivery afterwards', async () => {
    const { sender, lines } = createHarness();

    await sender.send(
      command({ deliveryMode: 'remux-video', jobId: 'job-9', selectedQuality: '720p' }),
    );

    const entry = lines.find((l) => l.message === 'media delivered');
    expect(entry).toBeDefined();
    expect(entry?.context).toMatchObject({
      jobId: 'job-9',
      selectedQuality: '720p',
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
      deliveryMode: 'remux-video',
      telegramApiRoot: 'http://telegram-bot-api:8081',
      telegramUploadLimitMb: 1_900,
      sentAs: 'video',
    });
    expect(typeof entry?.context?.uploadDurationMs).toBe('number');
  });

  it('records why a re-encode was declined', async () => {
    const { sender, lines } = createHarness();

    await sender.send(
      command({
        deliveryMode: 'direct-document',
        transcodeSkippedReason: 'file is 400 MB, over the 80 MB transcode ceiling',
      }),
    );

    const entry = lines.find((l) => l.message === 'media delivered');
    expect(entry?.context?.transcodeSkippedReason).toContain('transcode ceiling');
    expect(entry?.context?.sentAs).toBe('document');
  });

  it('never puts the bot token in the log', async () => {
    // `apiRoot` is the bare root; the token lives in the Api instance. A log
    // line carrying a full API URL would leak it into every aggregator.
    const { sender, lines } = createHarness();
    await sender.send(command());

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toMatch(/\d{8,}:[A-Za-z0-9_-]{30,}/);
    expect(serialized).not.toContain('/bot');
  });
});

describe('GrammyMediaSender never uploads the same file twice', () => {
  it('does not retry a document as a document when Telegram refuses it', async () => {
    // The mirror of the direct-document optimisation. Having skipped sendVideo
    // to avoid a wasted 1.9 GB upload, retrying the document as a document
    // would spend exactly that upload anyway, and reach the same refusal.
    const calls: string[] = [];
    const sendDocument = vi.fn(() => {
      calls.push('sendDocument');
      return Promise.reject(telegramError('Bad Request: unsupported message media type'));
    });
    const api = { sendVideo: vi.fn(), sendDocument };

    const sender = new GrammyMediaSender({
      api: api as unknown as Api,
      logger: createNoopLogger(),
      uploadTimeoutMs: 5_000,
      maxUploadBytes: 1_900 * MB,
      apiRoot: 'http://telegram-bot-api:8081',
    });

    await expect(sender.send(command({ deliveryMode: 'direct-document' }))).rejects.toBeDefined();

    expect(calls).toEqual(['sendDocument']);
    expect(api.sendVideo).not.toHaveBeenCalled();
  });
});
