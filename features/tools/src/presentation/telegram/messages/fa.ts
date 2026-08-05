import type { ToolErrorCode, ToolFamily, ToolJobStatus, ToolKey } from '@tgtools/shared';
import { assertNever, formatBytes } from '@tgtools/shared';

/**
 * Every string a tools user can see, in one file.
 *
 * Nothing here is assembled anywhere else, so adding a second language means
 * adding a sibling file and a lookup rather than hunting template literals
 * through twenty handlers.
 *
 * The error table is keyed by a domain code, never by a caught exception's
 * message. That is what keeps a poppler stack trace or an ffmpeg stderr line out
 * of a chat window: the worst a user can see is a sentence chosen from this
 * list.
 *
 * This module is imported by BOTH processes — the bot renders menus from it and
 * the worker renders status edits — which is the reason `ToolErrorCode` lives in
 * `@tgtools/shared` rather than in the engine. See the note there.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

/** Latin digits inside otherwise Persian text read as a stumble; these do not. */
export function toPersianDigits(value: string): string {
  return value.replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

/** Sizes are always shown to a user through here, never with a bare number. */
function bytes(value: number): string {
  return toPersianDigits(formatBytes(value));
}

/**
 * Typed as a total record, so adding a tool to the vocabulary without a Persian
 * name is a compile error rather than a raw slug shown to a user.
 */
export const TOOL_LABELS_FA: Readonly<Record<ToolKey, string>> = {
  'image.compress': '🗜 فشرده‌سازی تصویر',
  'image.resize': '📐 تغییر اندازهٔ تصویر',
  'image.convert': '🔄 تبدیل فرمت تصویر',
  'video.extract_mp3': '🎵 استخراج صدا (MP3)',
  'video.remove_audio': '🔇 حذف صدای ویدیو',
  // Filed under PDF, matching where it is queued and priced. A user looking for
  // it in the image submenu would not find it.
  'pdf.images_to_pdf': '📄 ساخت PDF از تصاویر',
  'pdf.to_images': '🖼 تبدیل PDF به تصویر',
  'qr.generate': '🔳 ساخت کد QR',
};

export const TOOL_FAMILY_LABELS_FA: Readonly<Record<ToolFamily, string>> = {
  image: '🖼 تصویر',
  video: '🎬 ویدیو',
  pdf: '📄 PDF',
  qr: '🔳 کد QR',
};

export const faTools = {
  menuTitle: 'ابزار موردنظرتان را انتخاب کنید:',

  menuIntro:
    'سلام! 👋\n\n' +
    'اینجا می‌توانید روی فایل‌هایتان کار کنید: فشرده‌سازی و تغییر اندازهٔ تصویر، ' +
    'استخراج صدا از ویدیو، ساخت و تبدیل PDF، و ساخت کد QR.\n\n' +
    'برای شروع یکی از دسته‌های زیر را انتخاب کنید.',

  buttonBack: '⬅️ بازگشت',
  buttonCancel: '✖️ لغو',
  buttonConfirm: '✅ تأیید و شروع',
  buttonDone: '✔️ تمام شد',

  callbackAcknowledged: 'ثبت شد',
  callbackExpired: 'این دکمه دیگر معتبر نیست. لطفاً دوباره /menu را بزنید.',

  cancelled: '✖️ درخواست لغو شد.',
  alreadyFinished: 'این درخواست پیش‌تر به پایان رسیده است.',

  sendTheFile: '📎 حالا فایل موردنظرتان را بفرستید.',
  sendTheImages:
    '📎 تصاویرتان را بفرستید — می‌توانید چند تصویر پشت سر هم ارسال کنید.\n\n' +
    'وقتی همه را فرستادید، دکمهٔ «تمام شد» را بزنید.',

  tooManyActiveJobs: '🚦 چند درخواست فعال دارید. لطفاً تا پایان آن‌ها صبر کنید.',

  toolsDisabled: '🛠 این بخش در حال حاضر غیرفعال است.',

  /**
   * What the user is looking at while the job runs.
   *
   * `receiving` and `processing` are deliberately different sentences. They fail
   * for entirely different reasons — a slow Telegram fetch against a slow
   * transcode — and someone watching a stuck job deserves to know which half it
   * is stuck in. That is the whole reason `receiving` exists as a status.
   */
  status(status: ToolJobStatus): string {
    switch (status) {
      case 'pending':
        return '⏳ در حال آماده‌سازی درخواست…';
      case 'queued':
        return '📋 در صف پردازش قرار گرفت.';
      case 'receiving':
        return '📥 در حال دریافت فایل از تلگرام…';
      case 'processing':
        return '⚙️ در حال پردازش…';
      case 'uploading':
        return '📤 در حال ارسال نتیجه…';
      case 'completed':
        return '✅ انجام شد.';
      case 'failed':
        return '⚠️ انجام نشد.';
      case 'cancelled':
        return '✖️ لغو شد.';
      case 'expired':
        return '⌛️ این درخواست منقضی شد.';
      default:
        return assertNever(status, 'tool job status');
    }
  },

  completed(tool: ToolKey, sizeBytes: number): string {
    return `✅ ${TOOL_LABELS_FA[tool]} انجام شد.\n\nحجم فایل: ${bytes(sizeBytes)}`;
  },

  /**
   * How much smaller the file became.
   *
   * Shown because it is the entire point of the tool: without it the user has
   * to open the file properties to find out whether anything happened.
   */
  compressionSummary(originalBytes: number, finalBytes: number): string {
    const saved = originalBytes - finalBytes;
    const percent = originalBytes > 0 ? Math.round((saved / originalBytes) * 100) : 0;
    return (
      `📉 ${toPersianDigits(String(percent))}٪ کوچک‌تر شد.\n` +
      `از ${bytes(originalBytes)} به ${bytes(finalBytes)}`
    );
  },

  /**
   * An already-optimised file re-encoded at a heavy preset often comes out
   * LARGER, and the processor hands back the original rather than the worse
   * result. Reporting a saving of zero would look like a bug, and saying
   * nothing would look like the tool had done nothing at all.
   */
  keptOriginal(): string {
    return (
      'ℹ️ این تصویر از قبل بهینه بوده است.\n\n' +
      'هر تنظیمی را امتحان کردیم فایل را بزرگ‌تر می‌کرد، پس نسخهٔ اصلی برایتان فرستاده شد.'
    );
  },

  /**
   * Best-effort by construction: some images cannot reach a small target
   * without becoming unrecognisable. Silently returning a larger file would
   * read as the target having been ignored.
   */
  targetMissed(targetBytes: number): string {
    return (
      `ℹ️ نتوانستیم فایل را تا ${bytes(targetBytes)} کوچک کنیم.\n\n` +
      'نزدیک‌ترین نتیجهٔ ممکن بدون افت شدید کیفیت برایتان فرستاده شد.'
    );
  },

  pagesRendered(count: number): string {
    return `✅ ${toPersianDigits(String(count))} صفحه تبدیل شد.`;
  },

  /**
   * Failure text, keyed by domain code.
   *
   * The switch is exhaustive and compiler-checked, so a new failure code cannot
   * reach production without someone deciding what to tell the person waiting.
   *
   * Note which messages do NOT say "کمی بعد دوباره تلاش کنید". A corrupt PDF, an
   * encrypted one and a silent video are not transient: inviting a retry sends
   * someone back to re-upload the same file, wait, and fail identically.
   */
  failure(code: ToolErrorCode): string {
    switch (code) {
      case 'TOOL_INPUT_TOO_LARGE':
        return '📦 حجم این فایل بیشتر از حد مجاز این ابزار است.';
      case 'TOOL_OUTPUT_TOO_LARGE':
        return (
          '📦 فایل ساخته‌شده بزرگ‌تر از حدی است که بتوان در تلگرام فرستاد.\n\n' +
          'با تنظیمات سبک‌تر — کیفیت یا اندازهٔ کمتر — دوباره امتحان کنید.'
        );
      case 'UNSUPPORTED_FILE_TYPE':
        return '❌ این نوع فایل پشتیبانی نمی‌شود.';
      case 'MIME_MISMATCH':
        // Says what is actually wrong. "پشتیبانی نمی‌شود" would send the user
        // looking for a supported format they are already using.
        return (
          '❌ محتوای این فایل با پسوندش هم‌خوانی ندارد.\n\n' +
          'لطفاً فایل اصلی را دوباره و بدون تغییر نام بفرستید.'
        );

      case 'INVALID_IMAGE':
        return '❌ این فایل یک تصویر سالم نیست.';
      case 'IMAGE_TOO_MANY_PIXELS':
        return '📐 ابعاد این تصویر بیش از حد بزرگ است و پردازشش ممکن نیست.';
      case 'ANIMATED_IMAGE_UNSUPPORTED':
        // The specific harm: Sharp silently keeps only the first frame, so the
        // user would get a still back and think the file was corrupted.
        return (
          '🎞 این تصویر متحرک است و این ابزار فقط تصویر ثابت را می‌پذیرد.\n\n' +
          'اگر ادامه می‌دادیم فقط فریم اول برایتان می‌ماند.'
        );

      case 'INVALID_VIDEO':
        return '❌ این فایل یک ویدیوی سالم نیست.';
      case 'VIDEO_HAS_NO_AUDIO':
        return '🔇 این ویدیو اصلاً صدا ندارد، پس چیزی برای استخراج وجود ندارد.';
      case 'VIDEO_ALREADY_MUTED':
        return '🔇 این ویدیو از قبل بی‌صداست.';
      case 'VIDEO_TOO_LONG':
        return '⏱ مدت این ویدیو بیشتر از حد مجاز این ابزار است.';

      case 'INVALID_PDF':
        return '❌ این فایل یک PDF سالم نیست.';
      case 'PDF_ENCRYPTED':
        return (
          '🔒 این PDF رمزگذاری شده است و بازش نمی‌کنیم.\n\n' +
          'اگر رمزش را دارید، ابتدا قفلش را بردارید و دوباره بفرستید.'
        );
      case 'PDF_TOO_MANY_PAGES':
        return '📄 تعداد صفحه‌های این PDF بیشتر از حد مجاز است.';
      case 'INVALID_PAGE_RANGE':
        return '📄 بازهٔ صفحه‌ای که انتخاب کردید در این PDF وجود ندارد.';

      case 'QR_INPUT_TOO_LONG':
        return (
          '🔳 متن واردشده برای یک کد QR بیش از حد بلند است.\n\n' +
          'متن کوتاه‌تری بفرستید تا کد خوانا بماند.'
        );

      case 'DISK_SPACE_LOW':
        // An operator problem, worded as one. Blaming the file would send the
        // user shrinking something that was never too big.
        return '🚧 سرور در حال حاضر ظرفیت خالی ندارد. کمی بعد دوباره تلاش کنید.';
      case 'TOOL_TIMEOUT':
        return '⌛️ پردازش بیش از حد طول کشید. کمی بعد دوباره تلاش کنید.';
      case 'TOOL_CANCELLED':
        return '✖️ درخواست لغو شد.';
      case 'TELEGRAM_FILE_UNAVAILABLE':
        return '⚠️ دریافت فایل از تلگرام ممکن نشد. کمی بعد دوباره تلاش کنید.';
      case 'TELEGRAM_UPLOAD_FAILED':
        return '⚠️ ارسال نتیجه به تلگرام انجام نشد. کمی بعد دوباره تلاش کنید.';
      case 'EXTERNAL_TOOL_FAILED':
        return '⚠️ پردازش این فایل با مشکل روبه‌رو شد. کمی بعد دوباره تلاش کنید.';
      case 'INTERNAL_ERROR':
        return '⚠️ مشکلی پیش آمد. کمی بعد دوباره تلاش کنید.';
      default:
        return assertNever(code, 'tool error code');
    }
  },
} as const;
