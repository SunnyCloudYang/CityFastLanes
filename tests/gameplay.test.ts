import { describe, expect, it } from 'vitest';
import type { Lane } from '../src/map/Lane';
import { Objectives } from '../src/sim/Objectives';
import { Replay, REPLAY_FORMAT_VERSION, type ReplayData, type ReplayInput } from '../src/sim/Replay';
import { TrafficScore } from '../src/sim/TrafficScore';
import { World } from '../src/sim/World';
import { addVehicle, makeMap } from './helpers';

function makeWorld(): World {
  return new World(
    makeMap({
      id: 'gameplay-test',
      name: 'Gameplay test',
      nodes: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: -100, y: 0 },
        { id: 2, x: 100, y: 0 },
        { id: 3, x: 0, y: -100 },
      ],
      roads: [
        { id: 0, from: 1, to: 0, speedLimit: 12 },
        { id: 1, from: 0, to: 2, speedLimit: 12 },
        { id: 2, from: 3, to: 0, speedLimit: 12 },
      ],
      bounds: { minX: -110, minY: -110, maxX: 110, maxY: 20 },
    }),
    0,
    0,
  );
}

function northApproach(world: World): Lane {
  const lane = world.net.roadLanes.find(
    (candidate) => candidate.nodeId === 0 && candidate.pointAt(candidate.length).t.y > 0.9,
  );
  if (!lane) throw new Error('Test map has no north approach');
  return lane;
}

describe('TrafficScore', () => {
  it('detects a red-light stop-line crossing once using vehicle history', () => {
    const world = makeWorld();
    const lane = northApproach(world);
    expect(lane.signal?.ctrl.state(lane.signal.group)).toBe('red');
    const vehicle = addVehicle(world, lane, { s: lane.length - 2 });
    vehicle.pos.x = lane.pointAt(lane.length + 1).p.x;
    vehicle.pos.y = lane.pointAt(lane.length + 1).p.y;

    const score = new TrafficScore();
    expect(score.step(world, vehicle, 1 / 60).score).toBe(85);
    expect(score.events.map((event) => event.type)).toEqual(['redLight']);

    vehicle.pos.x = lane.pointAt(lane.length + 2).p.x;
    vehicle.pos.y = lane.pointAt(lane.length + 2).p.y;
    expect(score.step(world, vehicle, 1 / 60).score).toBe(85);
    expect(score.events).toHaveLength(1);
  });

  it('rate-limits wrong-way penalties and does not count active violations as safe time', () => {
    const world = makeWorld();
    const lane = world.net.roadLanes[0];
    const vehicle = addVehicle(world, lane, { s: lane.length / 2, direction: -1 });
    const score = new TrafficScore({ cooldowns: { wrongWay: 1 } });

    expect(score.step(world, vehicle, 0.1).score).toBe(90);
    expect(score.step(world, vehicle, 0.1).score).toBe(90);
    expect(score.step(world, vehicle, 1).score).toBe(80);
    expect(score.events).toHaveLength(2);
    expect(score.safeDrivingTime).toBe(0);
    expect(score.safeStreak).toBe(0);
  });

  it('rate-limits collision notifications and accumulates safe driving time', () => {
    const world = makeWorld();
    const lane = world.net.roadLanes[0];
    const vehicle = addVehicle(world, lane, { s: lane.length / 2 });
    const score = new TrafficScore();

    expect(score.penalizeCollision()).toBe(true);
    expect(score.penalizeCollision()).toBe(false);
    expect(score.score).toBe(80);
    score.step(world, vehicle, 1.1);
    expect(score.penalizeCollision()).toBe(true);
    expect(score.score).toBe(60);
    expect(score.events.map((event) => event.type)).toEqual(['collision', 'collision']);

    const safeScore = new TrafficScore();
    safeScore.step(world, vehicle, 0.5);
    safeScore.step(world, vehicle, 0.5);
    expect(safeScore.safeDrivingTime).toBeCloseTo(1);
    expect(safeScore.safeStreak).toBeCloseTo(1);
  });
});

describe('Objectives', () => {
  it('creates reachable delivery/pickup routes and completes sequentially by proximity', () => {
    const world = makeWorld();
    const startLane = world.net.roadLanes[0];
    const vehicle = addVehicle(world, startLane, { s: startLane.length * 0.25 });

    for (const mode of ['delivery', 'pickup'] as const) {
      vehicle.pos.x = startLane.pointAt(startLane.length * 0.25).p.x;
      vehicle.pos.y = startLane.pointAt(startLane.length * 0.25).p.y;
      const objectives = new Objectives({ seed: 9, minDistance: 20, completionRadius: 5 });
      const objective = objectives.start(world, vehicle, mode);
      expect(objective).not.toBeNull();
      expect(objective?.mode).toBe(mode);
      expect(objective?.status).toBe('active');
      expect(objective?.route.length).toBeGreaterThan(0);
      expect(objective?.route[0].id).toBe(startLane.id);
      expect(objective?.routeLaneIds.at(-1)).toBe(objective?.destinationLaneId);
      expect(objective?.remainingTime).toBeNull();

      vehicle.pos.x = objective!.destination.x;
      vehicle.pos.y = objective!.destination.y;
      expect(objectives.step(world, vehicle, 0.1)?.status).toBe('completed');
      expect(objectives.completedCount).toBe(1);

      const next = objectives.next(world, vehicle);
      expect(next?.id).toBe(2);
      expect(next?.status).toBe('active');
      expect(next?.mode).toBe(mode);
    }
  });

  it('updates timed remaining time and expires only once', () => {
    const world = makeWorld();
    const lane = world.net.roadLanes[0];
    const vehicle = addVehicle(world, lane, { s: lane.length / 2 });
    const objectives = new Objectives({ seed: 2, minDistance: 20, timeLimit: 1 });

    expect(objectives.start(world, vehicle, 'timed')?.remainingTime).toBe(1);
    const active = objectives.step(world, vehicle, 0.4);
    expect(active?.status).toBe('active');
    expect(active?.remainingTime).toBeCloseTo(0.6);
    expect(objectives.step(world, vehicle, 0.6)?.status).toBe('expired');
    expect(objectives.current?.remainingTime).toBe(0);
    expect(objectives.step(world, vehicle, 1)?.status).toBe('expired');
    expect(objectives.expiredCount).toBe(1);
  });
});

const REPLAY_CONFIG = {
  seed: 42,
  mapId: 'downtown',
  initialVehicles: { motor: 70, bikes: 20 },
  dt: 1 / 60,
};
const INPUT_A: ReplayInput = { throttle: 0.75, steer: -0.25, handbrake: false };
const INPUT_B: ReplayInput = { throttle: -1, steer: 0.5, handbrake: true };

function replayData(): ReplayData {
  return {
    version: REPLAY_FORMAT_VERSION,
    ...REPLAY_CONFIG,
    initialVehicles: { ...REPLAY_CONFIG.initialVehicles },
    frames: [{ ...INPUT_A }, { ...INPUT_B }],
  };
}

describe('Replay', () => {
  it('roundtrips fixed-step input JSON and plays defensive input copies', () => {
    const recorder = new Replay(REPLAY_CONFIG);
    recorder.startRecording();
    expect(recorder.record(INPUT_A)).toBe(true);
    expect(recorder.record(INPUT_B)).toBe(true);
    const finished = recorder.finish();
    const json = recorder.exportJSON();

    const playback = Replay.importJSON(json);
    expect(playback.toData()).toEqual(finished);
    playback.startPlayback();
    expect(playback.nextInput()).toEqual(INPUT_A);
    const second = playback.nextInput();
    expect(second).toEqual(INPUT_B);
    expect(second).not.toBe(INPUT_B);
    expect(playback.nextInput()).toBeNull();
    expect(playback.mode).toBe('finished');

    const instanceImport = new Replay(REPLAY_CONFIG);
    instanceImport.startPlayback(json);
    expect(instanceImport.nextInput()).toEqual(INPUT_A);
  });

  it('rejects malformed JSON, invalid numbers and unsupported payloads', () => {
    expect(() => Replay.importJSON('{not json')).toThrow(/Invalid replay JSON/);
    const invalidPayloads: unknown[] = [
      { ...replayData(), version: 2 },
      { ...replayData(), dt: 0 },
      { ...replayData(), seed: -1 },
      { ...replayData(), mapId: '' },
      { ...replayData(), initialVehicles: { motor: -1, bikes: 20 } },
      { ...replayData(), initialVehicles: { motor: 2001, bikes: 20 } },
      { ...replayData(), frames: [{ ...INPUT_A, throttle: 2 }] },
      { ...replayData(), frames: [{ ...INPUT_A, steer: Number.NaN }] },
      { ...replayData(), frames: [{ ...INPUT_A, handbrake: 'false' }] },
    ];
    for (const payload of invalidPayloads) {
      expect(() => Replay.importJSON(JSON.stringify(payload))).toThrow(/Invalid replay/);
    }
  });

  it('enforces configurable frame limits below the global safety cap', () => {
    const json = JSON.stringify(replayData());
    expect(() => Replay.importJSON(json, { maxFrames: 1 })).toThrow(/frame limit/);

    const recorder = new Replay(REPLAY_CONFIG, { maxFrames: 1 });
    recorder.startRecording();
    recorder.record(INPUT_A);
    expect(() => recorder.record(INPUT_B)).toThrow(/frame limit/);
  });

  it('captures the driven vehicle id and round-trips it', () => {
    const recorder = new Replay(REPLAY_CONFIG);
    recorder.startRecording();
    expect(recorder.record(INPUT_A, 57)).toBe(true);
    const json = recorder.exportJSON();
    expect(JSON.parse(json).vehicleId).toBe(57);
    expect(Replay.importJSON(json).toData().vehicleId).toBe(57);

    expect(() => recorder.record(INPUT_B, -1)).toThrow(/vehicleId/);
    const bad = JSON.stringify({ ...replayData(), vehicleId: 1.5 });
    expect(() => Replay.importJSON(bad)).toThrow(/vehicleId/);

    const legacy = JSON.stringify({ ...replayData() });
    expect(Replay.importJSON(legacy).toData().vehicleId).toBeNull();
  });
});
