import { describe, expect, it } from 'vitest';
import {
  buildAudioDownloadArgs,
  buildBaseArgs,
  buildImageDownloadArgs,
  buildInspectArgs,
  buildVideoDownloadArgs,
} from './args-builder.js';

const MB = 1024 * 1024;
const base = { cookiePath: undefined, platformExtraArgs: [] as readonly string[] };

/** Every flag must be its own array element, or the value is read as a flag. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('buildBaseArgs', () => {
  it('ignores any yt-dlp.conf on the search path', () => {
    // Without this, a stray config file can silently change format selection,
    // the output path or the post-processing of a production download.
    expect(buildBaseArgs(base)).toContain('--ignore-config');
  });

  it('refuses to expand a link into a playlist', () => {
    expect(buildBaseArgs(base)).toContain('--no-playlist');
  });

  it('bounds the network wait and retries a few times', () => {
    const args = buildBaseArgs(base);
    expect(flagValue(args, '--socket-timeout')).toBe('30');
    expect(flagValue(args, '--retries')).toBe('3');
    expect(flagValue(args, '--fragment-retries')).toBe('3');
  });

  it('passes the cookie file only when there is one', () => {
    expect(buildBaseArgs(base)).not.toContain('--cookies');
    expect(
      flagValue(buildBaseArgs({ ...base, cookiePath: '/tmp/c/cookies.txt' }), '--cookies'),
    ).toBe('/tmp/c/cookies.txt');
  });

  it('appends the platform-specific arguments last', () => {
    const args = buildBaseArgs({ ...base, platformExtraArgs: ['--extractor-args', 'x:y'] });
    expect(args.slice(-2)).toEqual(['--extractor-args', 'x:y']);
  });

  it('routes through a proxy when one is configured', () => {
    // A residential exit is the account-free answer to a datacentre IP being
    // treated as suspicious.
    expect(
      flagValue(buildBaseArgs({ ...base, proxyUrl: 'socks5://10.0.0.9:1080' }), '--proxy'),
    ).toBe('socks5://10.0.0.9:1080');
    expect(buildBaseArgs(base)).not.toContain('--proxy');
  });

  it('passes operator-supplied extractor arguments', () => {
    // The escape hatch: a platform's newest anti-automation measure can be
    // answered with an environment variable instead of a release.
    expect(
      flagValue(
        buildBaseArgs({ ...base, extractorArgs: 'youtube:player_client=android_vr' }),
        '--extractor-args',
      ),
    ).toBe('youtube:player_client=android_vr');
    expect(buildBaseArgs(base)).not.toContain('--extractor-args');
  });
});

describe('buildInspectArgs', () => {
  it('asks for one JSON document and downloads nothing', () => {
    // The tolerance flag is asserted on its own below; this case only cares
    // that inspection asks for JSON and pulls no media.
    const args = buildInspectArgs({ ...base, ignoreNoFormatsError: false });
    expect(args).toContain('--dump-single-json');
    expect(args).toContain('--skip-download');
  });

  it('tolerates a post with no video formats on platforms that serve stills', () => {
    // Lets an image-only pin return JSON instead of aborting with "No video
    // formats found"; classifying image-vs-video is our job.
    expect(buildInspectArgs({ ...base, ignoreNoFormatsError: true })).toContain(
      '--ignore-no-formats-error',
    );
  });

  it('does NOT tolerate it on a video-only platform', () => {
    // On YouTube the flag turns a real failure — "Sign in to confirm you're not
    // a bot" — into a document with metadata and no formats, which reads as a
    // photo post and hides the reason from the user entirely.
    expect(buildInspectArgs({ ...base, ignoreNoFormatsError: false })).not.toContain(
      '--ignore-no-formats-error',
    );
  });
});

describe('buildVideoDownloadArgs', () => {
  const args = buildVideoDownloadArgs({
    ...base,
    outputTemplate: '/data/downloads/job-x/%(id).100s.%(ext)s',
    maxBytes: 500 * MB,
  });

  it('sets the declared-size ceiling in whole megabytes', () => {
    expect(flagValue(args, '--max-filesize')).toBe('500M');
  });

  it('forces an mp4 container', () => {
    expect(flagValue(args, '--merge-output-format')).toBe('mp4');
  });

  it('moves the moov atom to the front so playback can start early', () => {
    expect(flagValue(args, '--postprocessor-args')).toBe('ffmpeg:-movflags +faststart');
  });

  it('keeps the output template as a single argument', () => {
    // A template containing spaces or a quote must never be split, which is why
    // nothing here builds a command string.
    expect(flagValue(args, '--output')).toBe('/data/downloads/job-x/%(id).100s.%(ext)s');
  });
});

describe('buildAudioDownloadArgs', () => {
  const args = buildAudioDownloadArgs({
    ...base,
    outputTemplate: '/tmp/%(id)s.%(ext)s',
    maxBytes: 100 * MB,
    bitrateKbps: 192,
  });

  it('extracts to mp3 at the requested bitrate', () => {
    expect(args).toContain('--extract-audio');
    expect(flagValue(args, '--audio-format')).toBe('mp3');
    expect(flagValue(args, '--audio-quality')).toBe('192K');
  });

  it('keeps the metadata so the player shows more than a filename', () => {
    expect(args).toContain('--embed-metadata');
  });
});

describe('buildImageDownloadArgs', () => {
  const args = buildImageDownloadArgs({ ...base, outputTemplate: '/tmp/%(id)s.%(ext)s' });

  it('writes the thumbnail and skips the media', () => {
    expect(args).toContain('--write-thumbnail');
    expect(args).toContain('--skip-download');
    expect(args).toContain('--ignore-no-formats-error');
  });

  it('does not ask yt-dlp to convert the image', () => {
    // The alpha-channel decision needs a probe, so the conversion happens in the
    // image normaliser, not here.
    expect(args).not.toContain('--convert-thumbnails');
  });
});
