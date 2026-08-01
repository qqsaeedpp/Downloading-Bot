import type { AppContext, BotFeature } from '@tgtools/telegram';
import { Composer } from 'grammy';

export interface StartFeatureOptions {
  /**
   * The supported platforms, already formatted for display.
   *
   * Passed in rather than written here: this feature has no business knowing
   * what the downloader supports, and the list was previously hard-coded in
   * three separate files — so adding a platform left the welcome screen telling
   * users it was unsupported.
   */
  readonly supportedPlatforms: string;
}

function buildStartMessage(options: StartFeatureOptions): string {
  return [
    '👋 سلام!',
    '',
    'من می‌توانم ویدیو، عکس و صدای پست‌ها را برایتان دانلود کنم.',
    '',
    '<b>پلتفرم‌های پشتیبانی‌شده</b>',
    options.supportedPlatforms,
    '',
    '<b>چطور کار می‌کند؟</b>',
    'کافی است لینک پست را برایم بفرستید. اطلاعات رسانه را نشان می‌دهم و شما کیفیت دلخواه را انتخاب می‌کنید.',
    '',
    'برای دیدن راهنمای کامل، /help را بزنید.',
  ].join('\n');
}

/**
 * The first thing a new user sees.
 *
 * A feature in its own right rather than a line in the bot's bootstrap: it owns
 * its copy and its command registration, which is the same shape every future
 * tool will take.
 */
export function createStartFeature(options: StartFeatureOptions): BotFeature {
  const composer = new Composer<AppContext>();
  const message = buildStartMessage(options);

  composer.command('start', async (ctx) => {
    await ctx.reply(message, {
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
