import type { AppContext, BotFeature } from '@tgtools/telegram';
import { Composer } from 'grammy';

const START_MESSAGE = [
  '👋 سلام!',
  '',
  'من می‌توانم ویدیو، عکس و صدای پست‌ها را برایتان دانلود کنم.',
  '',
  '<b>پلتفرم‌های پشتیبانی‌شده</b>',
  '• اینستاگرام (ریل، پست ویدیویی، پست تصویری)',
  '• تیک‌تاک (شامل لینک‌های کوتاه)',
  '• پینترست (پین تصویری و ویدیویی)',
  '• ایکس / توییتر (ویدیو، گیف و تصویر)',
  '',
  '<b>چطور کار می‌کند؟</b>',
  'کافی است لینک پست را برایم بفرستید. اطلاعات رسانه را نشان می‌دهم و شما کیفیت دلخواه را انتخاب می‌کنید.',
  '',
  'برای دیدن راهنمای کامل، /help را بزنید.',
].join('\n');

/**
 * The first thing a new user sees.
 *
 * A feature in its own right rather than a line in the bot's bootstrap: it owns
 * its copy and its command registration, which is the same shape every future
 * tool will take.
 */
export function createStartFeature(): BotFeature {
  const composer = new Composer<AppContext>();

  composer.command('start', async (ctx) => {
    await ctx.reply(START_MESSAGE, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  return {
    name: 'start',
    composer,
    commands: [{ command: 'start', description: 'شروع کار با ربات' }],
  };
}
