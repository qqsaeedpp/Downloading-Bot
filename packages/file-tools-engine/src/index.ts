/**
 * The file-processing engine: Sharp, FFmpeg, Poppler, PDFKit and qrcode behind
 * plain interfaces.
 *
 * Nothing here knows about Telegram, BullMQ, Postgres or Persian. It takes
 * paths and options and produces files, which is what makes every rule in it
 * testable without a bot, a queue or a network.
 */

export {
  ToolError,
  ToolErrorCode,
  isRetryableToolError,
  isToolError,
  toToolError,
} from './errors/tool-error.js';
export type { ToolErrorOptions } from './errors/tool-error.js';

export { runProcess, runProcessOrThrow } from './process/child-process-runner.js';
export type { ProcessRunOptions, ProcessRunResult } from './process/child-process-runner.js';

export { ToolWorkspaceManager, assertNotSymlinked } from './workspace/tool-workspace.js';
export type { ToolWorkspace, WorkspaceManagerOptions } from './workspace/tool-workspace.js';

export {
  COMPRESSION_LEVEL_VALUES,
  COMPRESSION_PRESETS,
  IMAGE_FORMAT_VALUES,
  RESIZE_FIT_VALUES,
  RESIZE_PRESETS,
  isImageFormat,
  isResizePresetKey,
} from './image/image-processor.js';
export type {
  CompressOptions,
  CompressionLevel,
  CompressionPreset,
  ConvertOptions,
  ImageFormat,
  ImageLimits,
  ImageMetadata,
  ImageProcessor,
  ImageResult,
  ResizeFit,
  ResizeOptions,
  ResizePresetKey,
} from './image/image-processor.js';

export {
  DEFAULT_TARGET_SEARCH_POLICY,
  estimateScale,
  searchForTargetSize,
} from './image/target-size-search.js';
export type {
  EncodeProbe,
  TargetSearchAttempt,
  TargetSearchOutcome,
  TargetSearchPolicy,
} from './image/target-size-search.js';

export { SharpImageProcessor } from './image/sharp-image-processor.js';
export type { SharpImageProcessorOptions } from './image/sharp-image-processor.js';

export { MP3_QUALITY_VALUES, isMp3Quality } from './video/video-processor.js';
export type {
  AudioStreamInfo,
  ExtractMp3Options,
  Mp3Quality,
  VideoLimits,
  VideoMetadata,
  VideoOperationContext,
  VideoProcessor,
  VideoProgressListener,
  VideoResult,
  VideoStreamInfo,
} from './video/video-processor.js';

export {
  FfmpegProgressParser,
  assertUsableVideo,
  buildMp3Args,
  buildProbeArgs,
  buildRemoveAudioArgs,
  estimateMp3Bytes,
  mp3BitrateBps,
  parseFfprobeJson,
} from './video/ffmpeg-plan.js';

export { FfmpegVideoProcessor } from './video/ffmpeg-video-processor.js';
export type { FfmpegVideoProcessorOptions } from './video/ffmpeg-video-processor.js';
