import { DownloadType } from '@tgtools/shared';
import { InlineKeyboard } from 'grammy';
import type { DownloadOption } from '../../../domain/value-objects/download-option.js';
import { CallbackAction, encodeCallback } from '../callback-data.js';
import { fa } from '../messages/fa.js';

/** Two per row keeps the labels readable on a narrow phone. */
const VIDEO_COLUMNS = 2;
const AUDIO_COLUMNS = 3;

/**
 * The quality keyboard.
 *
 * Options are grouped by kind rather than listed flat, because a column of
 * mixed "1080p / 320 kbps / image" buttons gives the user no way to see at a
 * glance what the post actually offers.
 */
export function buildQualityKeyboard(
  shortId: string,
  options: readonly DownloadOption[],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  const images = options.filter((option) => option.type === DownloadType.Image);
  const videos = options.filter((option) => option.type === DownloadType.Video);
  const audios = options.filter((option) => option.type === DownloadType.Audio);

  for (const option of images) {
    keyboard.text(fa.buttonImage, callbackFor(shortId, option)).row();
  }

  appendGrid(keyboard, shortId, videos, VIDEO_COLUMNS);
  appendGrid(keyboard, shortId, audios, AUDIO_COLUMNS);

  keyboard.text(
    fa.buttonCancel,
    encodeCallback({ shortId, action: CallbackAction.Cancel, optionId: undefined }),
  );
  return keyboard;
}

function appendGrid(
  keyboard: InlineKeyboard,
  shortId: string,
  options: readonly DownloadOption[],
  columns: number,
): void {
  options.forEach((option, index) => {
    keyboard.text(
      fa.optionLabel(option.type, option.label, option.estimatedBytes),
      callbackFor(shortId, option),
    );
    const isLast = index === options.length - 1;
    if ((index + 1) % columns === 0 || isLast) keyboard.row();
  });
}

function callbackFor(shortId: string, option: DownloadOption): string {
  return encodeCallback({
    shortId,
    action: CallbackAction.SelectQuality,
    optionId: option.id,
  });
}

/** Shown while a job is running: the only thing left to offer is a way out. */
export function buildCancelKeyboard(shortId: string): InlineKeyboard {
  return new InlineKeyboard().text(
    fa.buttonCancel,
    encodeCallback({ shortId, action: CallbackAction.Cancel, optionId: undefined }),
  );
}
