import { MediaKind } from '@tgtools/shared';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { MediaInfo } from '../../../domain/entities/media-info.js';
import { buildQualityKeyboard } from '../keyboards/quality.keyboard.js';
import { PLATFORM_LABELS_FA, fa } from '../messages/fa.js';

export interface RenderedCard {
  readonly text: string;
  readonly keyboard: InlineKeyboardMarkup;
}

/**
 * Turns a `MediaInfo` into the message the user sees.
 *
 * Presentation only — no decisions about what is downloadable are made here, so
 * a change of wording cannot accidentally change behaviour.
 */
export function renderMediaCard(shortId: string, info: MediaInfo): RenderedCard {
  const prompt = info.mediaKind === MediaKind.Image ? fa.selectImage : fa.selectQuality;
  const card = fa.mediaCard({
    title: info.title,
    platformLabel: PLATFORM_LABELS_FA[info.platform],
    uploader: info.uploader,
    durationSeconds: info.durationSeconds,
    viewCount: info.statistics.viewCount,
    likeCount: info.statistics.likeCount,
  });

  return {
    text: `${card}\n\n${prompt}`,
    keyboard: buildQualityKeyboard(shortId, info.availableOptions),
  };
}
