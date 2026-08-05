import type { ToolKey } from '@tgtools/shared';
import { megabytesToBytes } from '@tgtools/shared';

/**
 * The questions each tool asks, as DATA rather than as a chain of handlers.
 *
 * Written this way for one reason: a conversation built from handlers can only
 * be tested by driving a fake Telegram through it, so the interesting rules —
 * which question comes next, whether the answer is usable, when there is
 * nothing left to ask — end up untested. As a table they are all decidable in
 * the unit suite, and the composer above becomes a loop with no branching of
 * its own.
 *
 * Every `id` and `value` is callback-data-safe: they travel on buttons, and the
 * codec refuses anything outside `[A-Za-z0-9_-]`.
 */

export interface ToolOptionChoice {
  /** Callback-safe. Short, because it shares the 64-byte budget with the rest. */
  readonly value: string;
  readonly label: string;
}

export type ToolOptionStep =
  | {
      readonly kind: 'choice';
      readonly id: string;
      readonly prompt: string;
      readonly choices: readonly ToolOptionChoice[];
    }
  | {
      /**
       * Answered by typing rather than tapping.
       *
       * Only QR needs one, and it is what the code will SAY — which is exactly
       * the value that must never appear on a button, in a log or in the job
       * row.
       */
      readonly kind: 'text';
      readonly id: string;
      readonly prompt: string;
    };

/** The named output sizes offered for a resize, with their real dimensions. */
const RESIZE_CHOICES: readonly ToolOptionChoice[] = [
  { value: 'sq', label: '⬛ مربع — ۱۰۸۰×۱۰۸۰' },
  { value: 'pt', label: '📱 عمودی — ۱۰۸۰×۱۳۵۰' },
  { value: 'ls', label: '🖼 افقی — ۱۰۸۰×۵۶۶' },
  { value: 'st', label: '📖 استوری — ۱۰۸۰×۱۹۲۰' },
  { value: 'og', label: '🔗 تصویر لینک — ۱۲۰۰×۶۳۰' },
  { value: 'w12', label: '🌐 وب کوچک — عرض ۱۲۰۰' },
  { value: 'w16', label: '🌐 وب متوسط — عرض ۱۶۰۰' },
  { value: 'w19', label: '🌐 وب بزرگ — عرض ۱۹۲۰' },
  { value: 'th', label: '🔲 بندانگشتی — ۴۰۰×۴۰۰' },
];

/**
 * What each resize choice means.
 *
 * `cover` crops to fill and is right for a feed, where a letterboxed picture
 * looks broken. `inside` never enlarges and is right for the web, where the
 * point is a ceiling rather than an exact shape. `fill` is offered nowhere: it
 * scales the axes independently, and a stretched face is the one result nobody
 * ever wants — the wire schema refuses it too.
 */
export const RESIZE_DIMENSIONS: Readonly<
  Record<string, { width: number; height?: number; fit: 'cover' | 'inside' }>
> = {
  sq: { width: 1080, height: 1080, fit: 'cover' },
  pt: { width: 1080, height: 1350, fit: 'cover' },
  ls: { width: 1080, height: 566, fit: 'cover' },
  st: { width: 1080, height: 1920, fit: 'cover' },
  og: { width: 1200, height: 630, fit: 'cover' },
  w12: { width: 1200, fit: 'inside' },
  w16: { width: 1600, fit: 'inside' },
  w19: { width: 1920, fit: 'inside' },
  th: { width: 400, height: 400, fit: 'cover' },
};

/** Target sizes offered for a compression, in bytes. `no` means "no target". */
export const COMPRESS_TARGETS: Readonly<Record<string, number | undefined>> = {
  no: undefined,
  m1: megabytesToBytes(1),
  m2: megabytesToBytes(2),
  m5: megabytesToBytes(5),
};

const STEPS: Readonly<Record<ToolKey, readonly ToolOptionStep[]>> = {
  'image.compress': [
    {
      kind: 'choice',
      id: 'lvl',
      prompt: 'چقدر فشرده شود؟',
      choices: [
        { value: 'high', label: '🟢 کیفیت بالا — کاهش کم' },
        { value: 'balanced', label: '🟡 متعادل — پیشنهاد ما' },
        { value: 'maximum', label: '🔴 حداکثر فشرده‌سازی' },
      ],
    },
    {
      kind: 'choice',
      id: 'tgt',
      prompt: 'حجم نهایی را محدود کنیم؟',
      choices: [
        { value: 'no', label: 'بدون محدودیت' },
        { value: 'm1', label: 'حداکثر ۱ مگابایت' },
        { value: 'm2', label: 'حداکثر ۲ مگابایت' },
        { value: 'm5', label: 'حداکثر ۵ مگابایت' },
      ],
    },
  ],

  'image.resize': [
    { kind: 'choice', id: 'sz', prompt: 'اندازهٔ خروجی را انتخاب کنید:', choices: RESIZE_CHOICES },
  ],

  'image.convert': [
    {
      kind: 'choice',
      id: 'fmt',
      prompt: 'به چه فرمتی تبدیل شود؟',
      choices: [
        { value: 'jpeg', label: 'JPEG — سازگار با همه‌جا' },
        { value: 'png', label: 'PNG — بدون افت کیفیت' },
        { value: 'webp', label: 'WebP — حجم کمتر' },
        { value: 'avif', label: 'AVIF — کمترین حجم' },
      ],
    },
  ],

  'video.extract_mp3': [
    {
      kind: 'choice',
      id: 'q',
      prompt: 'کیفیت صدا؟',
      choices: [
        { value: '128', label: '۱۲۸ کیلوبیت — حجم کم' },
        { value: '192', label: '۱۹۲ کیلوبیت — متعادل' },
        { value: '320', label: '۳۲۰ کیلوبیت — بیشترین کیفیت' },
        // Genuinely better for most material: a constant 320 spends the same
        // bits on silence as on a cymbal crash.
        { value: 'vbr', label: '🎚 متغیر (VBR) — پیشنهاد ما' },
      ],
    },
  ],

  // Nothing to ask. The tool does exactly one thing.
  'video.remove_audio': [],

  'pdf.images_to_pdf': [
    {
      kind: 'choice',
      id: 'mode',
      prompt: 'صفحه‌ها چطور ساخته شوند؟',
      choices: [
        { value: 'image', label: '🖼 هم‌اندازهٔ خود تصویر' },
        { value: 'a4-contain', label: '📄 A4 — کل تصویر داخل صفحه' },
        { value: 'a4-cover', label: '📄 A4 — پر کردن صفحه (برش)' },
      ],
    },
  ],

  'pdf.to_images': [
    {
      kind: 'choice',
      id: 'fmt',
      prompt: 'خروجی به چه فرمتی باشد؟',
      choices: [
        { value: 'png', label: 'PNG — بدون افت کیفیت' },
        { value: 'jpeg', label: 'JPEG — حجم کمتر' },
      ],
    },
    {
      kind: 'choice',
      id: 'dpi',
      prompt: 'کیفیت تبدیل؟',
      choices: [
        { value: '96', label: 'معمولی — برای نمایش' },
        { value: '150', label: 'خوب — پیشنهاد ما' },
        { value: '300', label: 'چاپ — حجم زیاد' },
      ],
    },
  ],

  'qr.generate': [
    {
      kind: 'choice',
      id: 'kind',
      prompt: 'کد QR برای چه چیزی؟',
      choices: [
        { value: 'text', label: '📝 متن' },
        { value: 'url', label: '🔗 لینک' },
        { value: 'wifi', label: '📶 وای‌فای' },
        { value: 'phone', label: '📞 شماره تماس' },
        { value: 'email', label: '✉️ ایمیل' },
        { value: 'geo', label: '📍 موقعیت جغرافیایی' },
        { value: 'vcard', label: '👤 کارت ویزیت' },
      ],
    },
    // The content is TYPED, never tapped. It can be a Wi-Fi password, so it
    // must not become callback data, a log line or a database column.
    { kind: 'text', id: 'body', prompt: 'حالا محتوای کد QR را بفرستید:' },
    {
      kind: 'choice',
      id: 'fmt',
      prompt: 'خروجی به چه صورت باشد؟',
      choices: [
        { value: 'png', label: '🖼 تصویر PNG' },
        { value: 'svg', label: '📐 SVG — برای چاپ' },
      ],
    },
  ],
};

export function optionStepsFor(tool: ToolKey): readonly ToolOptionStep[] {
  return STEPS[tool];
}

/**
 * The first question this tool has not yet been given an answer to.
 *
 * `undefined` means the flow is ready to confirm. Driven by what is MISSING
 * rather than by a counter, so a user who goes back and changes one answer
 * resumes at the right place instead of being asked everything again.
 */
export function nextOptionStep(
  tool: ToolKey,
  draft: Readonly<Record<string, unknown>>,
): ToolOptionStep | undefined {
  return optionStepsFor(tool).find((step) => draft[step.id] === undefined);
}

/** True once every question has an answer. */
export function isOptionDraftComplete(
  tool: ToolKey,
  draft: Readonly<Record<string, unknown>>,
): boolean {
  return nextOptionStep(tool, draft) === undefined;
}

/**
 * Whether a tapped value is one this step actually offered.
 *
 * Callback data is attacker-controlled: anyone can send an arbitrary
 * `callback_query`, and every button ever sent stays clickable forever. Without
 * this check a hand-made payload would put an arbitrary string into the draft
 * and reach the operation builder.
 */
export function isOfferedChoice(step: ToolOptionStep, value: string): boolean {
  if (step.kind !== 'choice') return false;
  return step.choices.some((choice) => choice.value === value);
}
