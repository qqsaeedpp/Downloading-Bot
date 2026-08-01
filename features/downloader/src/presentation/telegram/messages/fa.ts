import { ALL_MEDIA_PLATFORMS, DownloadStage, DownloadType } from '@tgtools/shared';
import type { MediaPlatform } from '@tgtools/shared';
import { assertNever, formatBytes, formatDuration, renderProgressBar } from '@tgtools/shared';
import { escapeHtml } from '@tgtools/telegram';
import { DownloadFailureCode } from '../../../domain/errors/download-failure-code.js';

/**
 * Every string a user can see, in one file.
 *
 * Nothing here is assembled anywhere else, so adding a second language means
 * adding a sibling file and a lookup — not hunting template literals through
 * twenty handlers. Raw yt-dlp and FFmpeg output never reaches this layer: the
 * error table is keyed by a domain code, so the worst a user sees is a sentence
 * chosen from this list.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

/** Latin digits inside otherwise Persian text read as a stumble; these do not. */
export function toPersianDigits(value: string): string {
  return value.replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

/**
 * Typed as a total record, so adding a platform to the vocabulary without a
 * Persian name is a compile error rather than a raw slug shown to a user.
 *
 * Declared before `fa` on purpose: `fa` reads it while initialising, and a
 * `const` referenced from its own temporal dead zone throws at import.
 */
export const PLATFORM_LABELS_FA: Readonly<Record<MediaPlatform, string>> = {
  instagram: 'اینستاگرام',
  tiktok: 'تیک‌تاک',
  pinterest: 'پینترست',
  x: 'ایکس (توییتر)',
  youtube: 'یوتیوب',
};

/**
 * The supported platforms as a Persian list: "الف، ب، ج و د".
 *
 * Derived rather than written out, because it previously was written out — in
 * three separate places — and adding YouTube left all three telling users that
 * YouTube was not supported, on the very screen they reached by pasting a
 * YouTube link.
 */
export function supportedPlatformsFa(): string {
  const labels = ALL_MEDIA_PLATFORMS.map((platform) => PLATFORM_LABELS_FA[platform]);
  if (labels.length <= 1) return labels[0] ?? '';
  const last = labels[labels.length - 1] ?? '';
  return `${labels.slice(0, -1).join('، ')} و ${last}`;
}

export const fa = {
  inspecting: '⏳ در حال بررسی لینک…',

  noUrlFound:
    'سلام! 👋\n\n' +
    'لینک یک پست، ریل، ویدیو یا پین را برایم بفرستید تا فایلش را برایتان دانلود کنم.\n\n' +
    `پلتفرم‌های پشتیبانی‌شده: ${supportedPlatformsFa()}.`,

  multipleUrls:
    '⚠️ در هر پیام فقط یک لینک بفرستید.\n\n' +
    'اولین لینک را بررسی می‌کنم؛ برای بقیه، هرکدام را جداگانه ارسال کنید.',

  queued: '📋 در صف دانلود قرار گرفت.',

  preparingFile: '⚙️ در حال آماده‌سازی فایل برای تلگرام…',

  uploading: '📤 در حال ارسال فایل…',

  cancelled: '✖️ درخواست لغو شد.',

  alreadyFinished: 'این درخواست پیش‌تر به پایان رسیده است.',

  selectQuality: 'رسانه پیدا شد. کیفیت موردنظر را انتخاب کنید:',

  selectImage: 'این پست یک تصویر است. برای دریافت آن دکمهٔ زیر را بزنید:',

  buttonCancel: '✖️ لغو',
  buttonAudioSection: '🎵 فقط صدا',
  buttonVideoSection: '🎬 ویدیو',
  buttonImage: '🖼 دریافت تصویر',

  callbackAcknowledged: 'ثبت شد',
  callbackExpired: 'این دکمه دیگر معتبر نیست.',

  /** The caption attached to the delivered file. */
  deliveredCaption(title: string, quality: string | undefined): string {
    const lines = [`✅ <b>${escapeHtml(title)}</b>`];
    if (quality !== undefined) lines.push(`کیفیت: ${toPersianDigits(escapeHtml(quality))}`);
    return lines.join('\n');
  },

  completed(fileSize: number): string {
    return `✅ دانلود با موفقیت انجام شد.\n\nحجم فایل: ${toPersianDigits(formatBytes(fileSize))}`;
  },

  /**
   * The media card. Every field is conditional because every platform omits a
   * different one — Pinterest has no duration, X has no view count.
   */
  mediaCard(input: {
    readonly title: string;
    readonly platformLabel: string;
    readonly uploader: string | undefined;
    readonly durationSeconds: number | undefined;
    readonly viewCount: number | undefined;
    readonly likeCount: number | undefined;
  }): string {
    const lines = [`🎬 <b>${escapeHtml(input.title)}</b>`, ''];
    lines.push(`پلتفرم: ${input.platformLabel}`);
    if (input.uploader !== undefined) lines.push(`منتشرکننده: ${escapeHtml(input.uploader)}`);
    if (input.durationSeconds !== undefined) {
      lines.push(`مدت: ${toPersianDigits(formatDuration(input.durationSeconds))}`);
    }
    if (input.viewCount !== undefined) {
      lines.push(`بازدید: ${toPersianDigits(input.viewCount.toLocaleString('en-US'))}`);
    }
    if (input.likeCount !== undefined) {
      lines.push(`پسند: ${toPersianDigits(input.likeCount.toLocaleString('en-US'))}`);
    }
    return lines.join('\n');
  },

  /**
   * A progress message that copes with an unknown total, which is the normal
   * case on Instagram and TikTok — neither reports a size, so a percentage bar
   * would sit at zero for the whole download.
   */
  downloadProgress(input: {
    readonly percent: number | undefined;
    readonly downloadedBytes: number;
    readonly totalBytes: number | undefined;
    readonly speedBytesPerSecond: number | undefined;
    readonly etaSeconds: number | undefined;
  }): string {
    const lines = ['⬇️ در حال دانلود…', ''];

    if (input.percent !== undefined && input.totalBytes !== undefined) {
      lines.push(
        `${renderProgressBar(input.percent)} ${toPersianDigits(String(Math.round(input.percent)))}٪`,
        '',
        `دانلودشده: ${toPersianDigits(formatBytes(input.downloadedBytes))} از ${toPersianDigits(formatBytes(input.totalBytes))}`,
      );
    } else {
      // Without a total there is nothing honest to draw, so report what is
      // certain rather than invent a bar.
      lines.push(`دانلودشده: ${toPersianDigits(formatBytes(input.downloadedBytes))}`);
    }

    if (input.speedBytesPerSecond !== undefined && input.speedBytesPerSecond > 0) {
      lines.push(`سرعت: ${toPersianDigits(formatBytes(input.speedBytesPerSecond))}/ثانیه`);
    }
    if (input.etaSeconds !== undefined && Number.isFinite(input.etaSeconds)) {
      lines.push(`زمان باقی‌مانده: ${toPersianDigits(formatDuration(input.etaSeconds))}`);
    }
    return lines.join('\n');
  },

  stage(stage: DownloadStage): string {
    switch (stage) {
      case DownloadStage.Preparing:
        return '⏳ در حال آماده‌سازی…';
      case DownloadStage.Downloading:
        return '⬇️ در حال دانلود…';
      case DownloadStage.Normalizing:
        return '⚙️ در حال بهینه‌سازی برای پخش در تلگرام…';
      case DownloadStage.Uploading:
        return '📤 در حال ارسال فایل…';
      default:
        return assertNever(stage, 'download stage');
    }
  },

  optionLabel(type: DownloadType, label: string, estimatedBytes: number | undefined): string {
    const icon = type === DownloadType.Audio ? '🎵' : type === DownloadType.Image ? '🖼' : '🎬';
    const size =
      estimatedBytes === undefined ? '' : ` • ${toPersianDigits(formatBytes(estimatedBytes, 0))}`;
    return `${icon} ${toPersianDigits(label)}${size}`;
  },

  /**
   * Failure text, keyed by domain code.
   *
   * The switch is exhaustive and checked by the compiler, so a new failure code
   * cannot reach production without someone deciding what to tell the person
   * waiting for their file.
   */
  failure(code: DownloadFailureCode): string {
    switch (code) {
      case DownloadFailureCode.InvalidUrl:
        return '❌ این لینک معتبر نیست. لطفاً آدرس کامل پست را بفرستید.';
      case DownloadFailureCode.UnsupportedPlatform:
        return (
          '❌ این لینک پشتیبانی نمی‌شود.\n\n' +
          `در حال حاضر ${supportedPlatformsFa()} پشتیبانی می‌شوند.`
        );
      case DownloadFailureCode.UnsupportedMedia:
        return '❌ محتوای قابل دانلودی در این لینک پیدا نشد.';
      case DownloadFailureCode.PrivateMedia:
        return '🔒 این محتوا خصوصی است و قابل دریافت نیست.';
      case DownloadFailureCode.LoginRequired:
        return '🔒 این محتوا خصوصی است یا برای دیدنش نیاز به ورود به حساب کاربری است.';
      case DownloadFailureCode.MediaNotFound:
        return '❌ این پست پیدا نشد. ممکن است حذف شده باشد.';
      case DownloadFailureCode.FormatUnavailable:
        return '❌ کیفیت انتخاب‌شده دیگر در دسترس نیست. لطفاً دوباره لینک را بفرستید.';
      case DownloadFailureCode.MediaTooLarge:
        return '📦 حجم این فایل بیشتر از حد مجاز برای ارسال در تلگرام است.';
      case DownloadFailureCode.DownloadTimeout:
        return '⌛️ دانلود بیش از حد طول کشید. کمی بعد دوباره تلاش کنید.';
      case DownloadFailureCode.ProcessingTimeout:
        return '⌛️ آماده‌سازی فایل بیش از حد طول کشید. کمی بعد دوباره تلاش کنید.';
      case DownloadFailureCode.DownloadFailed:
        return '⚠️ دریافت رسانه در حال حاضر ممکن نیست. کمی بعد دوباره تلاش کنید.';
      case DownloadFailureCode.ProcessingFailed:
        return '⚠️ آماده‌سازی فایل با مشکل روبه‌رو شد. کمی بعد دوباره تلاش کنید.';
      case DownloadFailureCode.UploadFailed:
        return '⚠️ ارسال فایل به تلگرام انجام نشد. کمی بعد دوباره تلاش کنید.';
      case DownloadFailureCode.JobCancelled:
        return '✖️ درخواست لغو شد.';
      case DownloadFailureCode.RateLimited:
        return '🚦 تعداد درخواست‌هایتان زیاد بوده است. کمی صبر کنید و دوباره تلاش کنید.';
      case DownloadFailureCode.TooManyActiveJobs:
        return '🚦 چند دانلود فعال دارید. لطفاً تا پایان آن‌ها صبر کنید.';
      case DownloadFailureCode.SelectionExpired:
        return '⌛️ این درخواست منقضی شده است. لطفاً دوباره لینک را بفرستید.';
      case DownloadFailureCode.InternalError:
        return '⚠️ مشکلی پیش آمد. کمی بعد دوباره تلاش کنید.';
      default:
        return assertNever(code, 'download failure code');
    }
  },
} as const;
