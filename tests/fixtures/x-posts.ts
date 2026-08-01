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

/**
 * What `--ignore-no-formats-error` turns a blocked YouTube extraction into.
 *
 * The metadata survives because it comes from the initial page data; `formats`
 * is empty because the player response — which carries them — was gated behind
 * "Sign in to confirm you're not a bot", which is what YouTube commonly answers
 * a datacentre IP with. Every field here is real except the identifiers.
 *
 * This shape is why a 36-minute video was offered as a still image: the
 * classifier saw no video formats, saw a thumbnail, and concluded "image".
 */
export const YOUTUBE_BLOCKED_NO_FORMATS = {
  id: '9BrUmidnzo0',
  title: 'بهترین و کمیاب‌ترین موبایل‌های دنیا!!!',
  uploader: 'Kouman',
  channel: 'Kouman',
  duration: 2200,
  thumbnail: 'https://i.ytimg.test/vi/9BrUmidnzo0/maxresdefault.jpg',
  upload_date: '20260115',
  view_count: 758_503,
  like_count: 77_925,
  extractor: 'youtube',
  webpage_url: 'https://www.youtube.com/watch?v=9BrUmidnzo0',
  formats: [],
  thumbnails: [{ url: 'https://i.ytimg.test/vi/9BrUmidnzo0/hq720.jpg', width: 1280, height: 720 }],
};

/** A YouTube Short: same shape as a long video, just briefer. */
export const YOUTUBE_SHORT = {
  id: 'sH0rt1dAbCd',
  title: 'A YouTube Short',
  uploader: 'Some Channel',
  duration: 42,
  thumbnail: 'https://i.ytimg.test/vi/sH0rt1dAbCd/maxresdefault.jpg',
  extractor: 'youtube',
  webpage_url: 'https://www.youtube.com/shorts/sH0rt1dAbCd',
  formats: [
    {
      format_id: '18',
      ext: 'mp4',
      width: 720,
      height: 1280,
      vcodec: 'avc1.42001E',
      acodec: 'mp4a.40.2',
      filesize: 3_500_000,
      tbr: 660,
      abr: 96,
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

/**
 * A TikTok photo post ("slideshow").
 *
 * The trap: it carries a `duration`, because a slideshow is set to a music
 * track. It is still a set of stills — `formats` is empty and the pictures
 * arrive as thumbnails. Any rule that reads "has a duration, therefore video"
 * turns this into an empty quality keyboard.
 */
export const TIKTOK_PHOTO_POST = {
  id: '7300000000000000001',
  title: 'A photo slideshow with a song',
  uploader: 'someone',
  duration: 15,
  extractor: 'tiktok',
  webpage_url: 'https://www.tiktok.com/@someone/photo/7300000000000000001',
  thumbnail: 'https://p16.tiktokcdn.test/slide-1.jpeg',
  formats: [],
  thumbnails: [
    { url: 'https://p16.tiktokcdn.test/slide-1.jpeg', width: 1080, height: 1920 },
    { url: 'https://p16.tiktokcdn.test/slide-2.jpeg', width: 1080, height: 1920 },
  ],
};

/**
 * An Instagram carousel whose first entry is a photo, with the reel's audio
 * duration still reported. Same shape of trap as the TikTok slideshow.
 */
export const INSTAGRAM_PHOTO_POST = {
  id: 'ABC123',
  title: 'A photo post',
  uploader: 'someone',
  duration: 27,
  extractor: 'instagram',
  webpage_url: 'https://www.instagram.com/p/ABC123/',
  thumbnail: 'https://scontent.cdninstagram.test/photo.jpg',
  formats: [],
  thumbnails: [{ url: 'https://scontent.cdninstagram.test/photo.jpg', width: 1080, height: 1350 }],
};

/**
 * A normal TikTok video: one pre-muxed rendition, no height reported. Present
 * so the fix for the slideshow can be shown not to cost the ordinary case.
 */
export const TIKTOK_VIDEO_POST = {
  id: '7300000000000000002',
  title: 'An ordinary TikTok video',
  uploader: 'someone',
  duration: 31,
  extractor: 'tiktok',
  webpage_url: 'https://www.tiktok.com/@someone/video/7300000000000000002',
  thumbnail: 'https://p16.tiktokcdn.test/cover.jpeg',
  formats: [
    {
      format_id: 'download_addr-0',
      ext: 'mp4',
      vcodec: 'h264',
      acodec: 'aac',
      filesize: 3_200_000,
      protocol: 'https',
    },
  ],
};
