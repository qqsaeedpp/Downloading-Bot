import { describe, expect, it } from 'vitest';
import { EngineFailureCode } from './engine-error.js';
import { YtDlpErrorMapper } from './ytdlp-error-mapper.js';

const mapper = new YtDlpErrorMapper();

function classify(stderr: string) {
  return mapper.map({ exitCode: 1, signal: null, stderr });
}

describe('a platform refusing the server is not the same as private content', () => {
  it('classifies the real YouTube bot check, captured verbatim from production', () => {
    // Exactly what the deployed bot received, apostrophe and all.
    const stderr =
      'WARNING: [youtube] No title found in player responses; falling back to title from initial data. Other metadata may also be missing\n' +
      'ERROR: [youtube] 9BrUmidnzo0: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication. See https://github.com/yt-dlp/yt-dlp/wiki/FAQ for how to manually pass cookies.';

    // Previously this landed on LOGIN_REQUIRED, because the message ends with
    // "Use --cookies". The user was then told their perfectly public video was
    // private — blaming them for a deployment problem they cannot see.
    expect(classify(stderr).code).toBe(EngineFailureCode.PlatformBlocked);
  });

  it('matches the curly apostrophe yt-dlp actually emits AND a straight one', () => {
    // U+2019 is what yt-dlp prints. A pattern written with an ASCII quote
    // matches none of the real occurrences, which is a silent miss.
    for (const apostrophe of ['’', "'"]) {
      const stderr = `ERROR: [youtube] abc: Sign in to confirm you${apostrophe}re not a bot.`;
      expect(classify(stderr).code, apostrophe).toBe(EngineFailureCode.PlatformBlocked);
    }
  });

  it('is not retryable, because the same address gets the same refusal', () => {
    const error = classify('ERROR: Sign in to confirm you’re not a bot.');
    expect(error.retryable).toBe(false);
  });

  it('still reports genuinely gated content as needing a login', () => {
    // The distinction has to survive: these are about the CONTENT.
    expect(classify('ERROR: [instagram] abc: Requested content is not available').code).toBe(
      EngineFailureCode.LoginRequired,
    );
    expect(classify('ERROR: [twitter] 1: You need to log in').code).toBe(
      EngineFailureCode.LoginRequired,
    );
  });

  it('still reports a private post as private', () => {
    expect(classify('ERROR: [instagram] abc: This account is private').code).toBe(
      EngineFailureCode.PrivateMedia,
    );
  });
});
