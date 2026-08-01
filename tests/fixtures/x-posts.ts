/**
 * Sanitised `yt-dlp --dump-single-json` output for X / Twitter posts.
 *
 * Shapes captured from the twitter extractor and stripped of identifying
 * detail. They exist because the deterministic suite must not depend on live
 * URLs: a tweet can be deleted, protected or rate-limited, and a test that goes
 * red for those reasons stops meaning anything.
 */

/** A tweet carrying a normal H.264 video with sound. */
export const X_VIDEO_POST = {
  id: '1700000000000000001',
  title: 'A tweet with a video',
  uploader: 'someone',
  duration: 31,
  thumbnail: 'https://pbs.twimg.test/media/video-thumb.jpg',
  upload_date: '20260210',
  view_count: 12000,
  like_count: 340,
  webpage_url: 'https://x.com/someone/status/1700000000000000001',
  extractor: 'twitter',
  formats: [
    {
      format_id: 'http-832',
      ext: 'mp4',
      width: 480,
      height: 270,
      vcodec: 'avc1.4d401e',
      acodec: 'mp4a.40.2',
      tbr: 832,
      abr: 128,
      protocol: 'https',
    },
    {
      format_id: 'http-2176',
      ext: 'mp4',
      width: 1280,
      height: 720,
      vcodec: 'avc1.640020',
      acodec: 'mp4a.40.2',
      tbr: 2176,
      abr: 128,
      protocol: 'https',
    },
  ],
};

/**
 * A tweeted GIF. X stores these as silent MP4s, so `acodec` is the string
 * `"none"` — a real declaration of absence, not a missing field.
 */
export const X_GIF_POST = {
  id: '1700000000000000002',
  title: 'A tweet with a gif',
  uploader: 'someone',
  duration: 4,
  thumbnail: 'https://pbs.twimg.test/tweet_video_thumb/gif.jpg',
  extractor: 'twitter',
  formats: [
    {
      format_id: 'http-540',
      ext: 'mp4',
      width: 498,
      height: 280,
      vcodec: 'avc1.42c015',
      acodec: 'none',
      tbr: 540,
      protocol: 'https',
    },
  ],
};

/**
 * A single-photo tweet. With `--ignore-no-formats-error` the extractor returns
 * a document with no formats at all and only a thumbnail — which is what made
 * the old classifier fall through to `unknown`.
 */
export const X_SINGLE_PHOTO_POST = {
  id: '1700000000000000003',
  title: 'A tweet with one photo',
  uploader: 'someone',
  upload_date: '20260211',
  like_count: 88,
  thumbnail: 'https://pbs.twimg.test/media/photo1.jpg',
  extractor: 'twitter',
  webpage_url: 'https://x.com/someone/status/1700000000000000003',
  formats: [],
  thumbnails: [
    { url: 'https://pbs.twimg.test/media/photo1.jpg?name=small', width: 340, height: 227 },
    { url: 'https://pbs.twimg.test/media/photo1.jpg?name=large', width: 2048, height: 1365 },
  ],
};

/**
 * A multi-photo tweet. The extractor wraps the images in a playlist, so the
 * mapper's existing first-entry behaviour applies.
 */
export const X_MULTI_PHOTO_POST = {
  _type: 'playlist',
  id: '1700000000000000004',
  title: 'A tweet with four photos',
  uploader: 'someone',
  extractor: 'twitter',
  webpage_url: 'https://x.com/someone/status/1700000000000000004',
  entries: [
    {
      id: '1700000000000000004-1',
      title: 'A tweet with four photos - 1',
      ext: 'jpg',
      thumbnail: 'https://pbs.twimg.test/media/photo-a.jpg',
      formats: [],
    },
    {
      id: '1700000000000000004-2',
      title: 'A tweet with four photos - 2',
      ext: 'jpg',
      thumbnail: 'https://pbs.twimg.test/media/photo-b.jpg',
      formats: [],
    },
  ],
};

/**
 * A text-only tweet: nothing to download at all. The correct answer is a typed
 * unsupported-media error, not an invented option.
 */
export const X_TEXT_ONLY_POST = {
  id: '1700000000000000005',
  title: 'Just some words',
  uploader: 'someone',
  extractor: 'twitter',
  webpage_url: 'https://x.com/someone/status/1700000000000000005',
  formats: [],
};

/** A tweet with both a photo and a video: the video is the downloadable part. */
export const X_MIXED_MEDIA_POST = {
  _type: 'playlist',
  id: '1700000000000000006',
  title: 'A tweet with a photo and a video',
  uploader: 'someone',
  extractor: 'twitter',
  entries: [
    {
      id: '1700000000000000006-1',
      title: 'A tweet with a photo and a video - 1',
      duration: 12,
      thumbnail: 'https://pbs.twimg.test/media/mixed-thumb.jpg',
      formats: [
        {
          format_id: 'http-1280',
          ext: 'mp4',
          width: 720,
          height: 1280,
          vcodec: 'avc1.4d401f',
          acodec: 'mp4a.40.2',
          tbr: 1280,
          abr: 128,
        },
      ],
    },
  ],
};

/** A YouTube video, for the platform-parity assertions. */
export const YOUTUBE_VIDEO = {
  id: 'dQw4w9WgXcQ',
  title: 'A YouTube video',
  uploader: 'Some Channel',
  channel: 'Some Channel',
  duration: 213,
  thumbnail: 'https://i.ytimg.test/vi/dQw4w9WgXcQ/maxresdefault.jpg',
  upload_date: '20260101',
  view_count: 1_400_000,
  like_count: 42_000,
  extractor: 'youtube',
  webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  formats: [
    {
      format_id: '18',
      ext: 'mp4',
      width: 640,
      height: 360,
      vcodec: 'avc1.42001E',
      acodec: 'mp4a.40.2',
      filesize: 12_000_000,
      tbr: 450,
      abr: 96,
      protocol: 'https',
    },
    {
      format_id: '137',
      ext: 'mp4',
      width: 1920,
      height: 1080,
      vcodec: 'avc1.640028',
      acodec: 'none',
      filesize: 60_000_000,
      tbr: 2500,
      protocol: 'https',
    },
    {
      format_id: '140',
      ext: 'm4a',
      vcodec: 'none',
      acodec: 'mp4a.40.2',
      filesize: 3_400_000,
      abr: 128,
      protocol: 'https',
    },
  ],
};
