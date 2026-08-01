import type { AppContext, BotFeature } from '@tgtools/telegram';
import { Composer } from 'grammy';

export interface HelpFeatureOptions {
  /** Shown so the user knows the ceiling before waiting for a large file. */
  readonly maxUploadMegabytes: number;
  /** Supplied by the composition root; see `StartFeatureOptions`. */
  readonly supportedPlatforms: string;
}

function buildHelpMessage(options: HelpFeatureOptions): string {
  return [
    '<b>راهنمای استفاده</b>',
    '',
    `پلتفرم‌های پشتیبانی‌شده: ${options.supportedPlatforms}`,
    '',
    '۱. لینک پست، ریل، ویدیو یا پین را بفرستید.',
    '۲. چند لحظه صبر کنید تا اطلاعات رسانه را نشان دهم.',
    '۳. کیفیت موردنظر را از دکمه‌ها انتخاب کنید.',
    '۴. فایل آماده و برایتان ارسال می‌شود.',
    '',
    '<b>نکته‌ها</b>',
    '• در هر پیام فقط یک لینک بفرستید.',
    `• حداکثر حجم فایل ارسالی ${options.maxUploadMegabytes} مگابایت است.`,
    '• پست‌های خصوصی یا نیازمند ورود قابل دریافت نیستند.',
    '• اگر دانلود طول کشید، با دکمهٔ «لغو» می‌توانید متوقفش کنید.',
    '',
    '<b>دستورها</b>',
    '/start — شروع',
    '/help — همین راهنما',
    '',
    'مسئولیت رعایت حقوق مالکیت محتوا و شرایط استفادهٔ پلتفرم‌ها بر عهدهٔ کاربر است.',
  ].join('\n');
}

export function createHelpFeature(options: HelpFeatureOptions): BotFeature {
  const composer = new Composer<AppContext>();
  const message = buildHelpMessage(options);

  composer.command('help', async (ctx) => {
    await ctx.reply(message, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  return {
    name: 'help',
    composer,
    commands: [{ command: 'help', description: 'راهنمای استفاده' }],
  };
}
