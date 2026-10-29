/// <reference lib="webworker" />

import type { SimulationCommand, SimulationSnapshot } from './protocol';
import { PEDESTRIAN_SNAPSHOT_STRIDE, SNAPSHOT_STRIDE } from './protocol';
import { VEHICLE_KINDS } from './Vehicle';
import { World } from './World';

let world: World | null = null;

function snapshot(): void {
  if (!world) return;
  const data = new Float32Array(world.vehicles.length * SNAPSHOT_STRIDE);
  for (let i = 0; i < world.vehicles.length; i++) {
    const v = world.vehicles[i];
    const o = i * SNAPSHOT_STRIDE;
    data[o] = v.id;
    data[o + 1] = VEHICLE_KINDS.indexOf(v.kind);
    data[o + 2] = v.color;
    data[o + 3] = v.driverFactor;
    data[o + 4] = v.pos.x;
    data[o + 5] = v.pos.y;
    data[o + 6] = v.heading;
    data[o + 7] = v.prevPos.x;
    data[o + 8] = v.prevPos.y;
    data[o + 9] = v.prevHeading;
    data[o + 10] = v.speed;
    data[o + 11] = v.steer;
    data[o + 12] = v.controller === 'player' ? 1 : 0;
  }
  const pedestrianData = new Float32Array(world.pedestrians.length * PEDESTRIAN_SNAPSHOT_STRIDE);
  for (let i = 0; i < world.pedestrians.length; i++) {
    const pedestrian = world.pedestrians[i];
    const o = i * PEDESTRIAN_SNAPSHOT_STRIDE;
    pedestrianData[o] = pedestrian.id;
    pedestrianData[o + 1] = pedestrian.pos.x;
    pedestrianData[o + 2] = pedestrian.pos.y;
    pedestrianData[o + 3] = pedestrian.prevPos.x;
    pedestrianData[o + 4] = pedestrian.prevPos.y;
  }
  const routes: Record<number, number[]> = {};
  for (const v of world.vehicles) routes[v.id] = [v.lane?.id ?? -1, ...v.route.map((lane) => lane.id)];
  const message: SimulationSnapshot = {
    type: 'snapshot',
    data: data.buffer,
    pedestrianData: pedestrianData.buffer,
    time: world.time,
    routes,
    collisions: world.collisionCount,
  };
  self.postMessage(message, [message.data, message.pedestrianData]);
}

self.onmessage = (event: MessageEvent<SimulationCommand>) => {
  const command = event.data;
  if (command.type === 'init') {
    world = new World(command.def, command.cars, command.bikes);
  } else if (!world) {
    return;
  } else if (command.type === 'step') {
    if (command.input) {
      const v = world.vehicles.find((vehicle) => vehicle.id === command.input!.id);
      if (v?.controller === 'player') {
        v.input.throttle = command.input.throttle;
        v.input.steer = command.input.steer;
        v.input.handbrake = command.input.handbrake;
      }
    }
    world.step(command.dt);
  } else if (command.type === 'counts') {
    world.targetMotor = command.cars;
    world.targetBikes = command.bikes;
  } else if (command.type === 'signals') {
    world.setSignalScale(command.scale);
  } else {
    const v = world.vehicles.find((vehicle) => vehicle.id === command.id);
    if (command.type === 'protect') {
      world.protectedIds.clear();
      if (command.id > 0) world.protectedIds.add(command.id);
    } else if (v && command.type === 'take') {
      world.takeControl(v);
    } else if (v) {
      world.releaseControl(v);
    }
  }
  snapshot();
};
