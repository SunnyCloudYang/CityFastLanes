import { clamp } from '../core/math';

export const REPLAY_FORMAT_VERSION = 1;
export const REPLAY_LIMITS = {
  maxFrames: 360_000,
  maxInitialVehicles: 2_000,
  maxMapIdLength: 128,
  maxDt: 1,
} as const;

export interface ReplayInput {
  throttle: number;
  steer: number;
  handbrake: boolean;
}

export interface ReplayConfig {
  seed: number;
  mapId: string;
  /** Initial World target populations, needed to reconstruct the simulation. */
  initialVehicles: {
    motor: number;
    bikes: number;
  };
  /** Fixed simulation step in seconds. */
  dt: number;
}

export interface ReplayData extends ReplayConfig {
  version: typeof REPLAY_FORMAT_VERSION;
  frames: ReplayInput[];
}

export interface ReplayOptions {
  /** A lower per-instance cap is useful for short sessions and tests. */
  maxFrames?: number;
}

export type ReplayMode = 'idle' | 'recording' | 'playback' | 'finished';

/** Lightweight fixed-step input recorder/player. No World state is retained. */
export class Replay {
  private config: ReplayConfig;
  private frames: ReplayInput[] = [];
  private readonly maxFrames: number;
  private currentMode: ReplayMode = 'idle';
  private cursor = 0;

  constructor(config: ReplayConfig, options: ReplayOptions = {}) {
    this.maxFrames = frameLimit(options.maxFrames);
    // Reuse import validation for constructor numbers and map metadata.
    validateHeader({ ...config, version: REPLAY_FORMAT_VERSION });
    this.config = copyConfig(config);
  }

  static importJSON(json: string, options: ReplayOptions = {}): Replay {
    const data = parseJSON(json, frameLimit(options.maxFrames));
    const replay = new Replay(
      {
        seed: data.seed,
        mapId: data.mapId,
        initialVehicles: data.initialVehicles,
        dt: data.dt,
      },
      options,
    );
    replay.frames = data.frames;
    return replay;
  }

  get mode(): ReplayMode {
    return this.currentMode;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get playbackIndex(): number {
    return this.cursor;
  }

  get isRecording(): boolean {
    return this.currentMode === 'recording';
  }

  get isPlaying(): boolean {
    return this.currentMode === 'playback';
  }

  startRecording(): void {
    this.frames = [];
    this.cursor = 0;
    this.currentMode = 'recording';
  }

  /** Records a defensive, clamped input sample. Returns false unless recording. */
  record(input: ReplayInput): boolean {
    if (this.currentMode !== 'recording') return false;
    if (this.frames.length >= this.maxFrames) {
      throw new RangeError(`Replay exceeds the ${this.maxFrames}-frame limit`);
    }
    if (!Number.isFinite(input.throttle) || !Number.isFinite(input.steer)) {
      throw new TypeError('Replay input throttle and steer must be finite numbers');
    }
    this.frames.push({
      throttle: clamp(input.throttle, -1, 1),
      steer: clamp(input.steer, -1, 1),
      handbrake: Boolean(input.handbrake),
    });
    return true;
  }

  /** Stops recording/playback and returns an immutable-by-copy replay payload. */
  finish(): ReplayData {
    this.currentMode = 'idle';
    this.cursor = 0;
    return this.toData();
  }

  /** Starts current frames, or replaces them with a validated JSON/payload import. */
  startPlayback(source?: string | ReplayData): void {
    if (source !== undefined) {
      const data = typeof source === 'string' ? parseJSON(source, this.maxFrames) : validateReplay(source, this.maxFrames);
      this.config = copyConfig(data);
      this.frames = data.frames;
    } else if (this.frames.length > this.maxFrames) {
      throw new RangeError(`Replay exceeds the ${this.maxFrames}-frame limit`);
    }
    this.cursor = 0;
    this.currentMode = 'playback';
  }

  /** Returns the next input copy, or null when playback ends/is not active. */
  nextInput(): ReplayInput | null {
    if (this.currentMode !== 'playback') return null;
    if (this.cursor >= this.frames.length) {
      this.currentMode = 'finished';
      return null;
    }
    return { ...this.frames[this.cursor++] };
  }

  toData(): ReplayData {
    return {
      version: REPLAY_FORMAT_VERSION,
      ...copyConfig(this.config),
      frames: this.frames.map((frame) => ({ ...frame })),
    };
  }

  exportJSON(): string {
    return JSON.stringify(this.toData());
  }
}

function parseJSON(json: string, maxFrames: number = REPLAY_LIMITS.maxFrames): ReplayData {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new SyntaxError(`Invalid replay JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateReplay(value, maxFrames);
}

function validateReplay(value: unknown, maxFrames: number): ReplayData {
  if (!isRecord(value)) throw new TypeError('Invalid replay: expected an object');
  validateHeader(value);
  if (!Array.isArray(value.frames)) throw new TypeError('Invalid replay: frames must be an array');
  if (value.frames.length > maxFrames) {
    throw new RangeError(`Invalid replay: frames exceed the ${maxFrames}-frame limit`);
  }
  const frames = value.frames.map((frame, index): ReplayInput => {
    if (!isRecord(frame)) throw new TypeError(`Invalid replay: frame ${index} must be an object`);
    if (!isUnitNumber(frame.throttle) || !isUnitNumber(frame.steer)) {
      throw new RangeError(`Invalid replay: frame ${index} throttle/steer must be finite numbers in [-1, 1]`);
    }
    if (typeof frame.handbrake !== 'boolean') {
      throw new TypeError(`Invalid replay: frame ${index} handbrake must be boolean`);
    }
    return { throttle: frame.throttle, steer: frame.steer, handbrake: frame.handbrake };
  });
  return {
    version: REPLAY_FORMAT_VERSION,
    seed: value.seed as number,
    mapId: value.mapId as string,
    initialVehicles: {
      motor: (value.initialVehicles as { motor: number }).motor,
      bikes: (value.initialVehicles as { bikes: number }).bikes,
    },
    dt: value.dt as number,
    frames,
  };
}

function validateHeader(value: Record<string, unknown>): void {
  if (value.version !== REPLAY_FORMAT_VERSION) throw new Error('Invalid replay: unsupported version');
  if (!Number.isSafeInteger(value.seed) || (value.seed as number) < 0) {
    throw new RangeError('Invalid replay: seed must be a non-negative safe integer');
  }
  if (
    typeof value.mapId !== 'string' ||
    value.mapId.trim().length === 0 ||
    value.mapId.length > REPLAY_LIMITS.maxMapIdLength
  ) {
    throw new TypeError('Invalid replay: mapId must be a non-empty, bounded string');
  }
  if (!Number.isFinite(value.dt) || (value.dt as number) <= 0 || (value.dt as number) > REPLAY_LIMITS.maxDt) {
    throw new RangeError(`Invalid replay: dt must be in (0, ${REPLAY_LIMITS.maxDt}]`);
  }
  if (!isRecord(value.initialVehicles)) throw new TypeError('Invalid replay: initialVehicles must be an object');
  for (const key of ['motor', 'bikes'] as const) {
    const count = value.initialVehicles[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > REPLAY_LIMITS.maxInitialVehicles) {
      throw new RangeError(`Invalid replay: initialVehicles.${key} is outside the supported range`);
    }
  }
}

function copyConfig(config: ReplayConfig): ReplayConfig {
  return {
    seed: config.seed,
    mapId: config.mapId,
    initialVehicles: { ...config.initialVehicles },
    dt: config.dt,
  };
}

function frameLimit(value: number | undefined): number {
  if (value === undefined) return REPLAY_LIMITS.maxFrames;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('maxFrames must be a positive safe integer');
  return Math.min(value, REPLAY_LIMITS.maxFrames);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1;
}
