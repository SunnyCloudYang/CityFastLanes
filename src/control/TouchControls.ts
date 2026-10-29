import { Input } from './Input';

/** Pointer-based virtual joystick; mouse users never see these controls. */
export class TouchControls {
  constructor(input: Input, onDrive: () => void, onView: () => void) {
    const pad = document.getElementById('touch-joystick')!;
    const knob = document.getElementById('touch-knob')!;
    let pointer: number | null = null;
    const update = (event: PointerEvent) => {
      const rect = pad.getBoundingClientRect();
      const x = event.clientX - rect.left - rect.width / 2;
      const y = event.clientY - rect.top - rect.height / 2;
      const length = Math.max(1, Math.hypot(x, y));
      const radius = Math.min(rect.width * 0.32, length);
      const nx = (x / length) * radius;
      const ny = (y / length) * radius;
      knob.style.transform = `translate(${nx}px, ${ny}px)`;
      input.touchSteer = nx / (rect.width * 0.32);
      input.touchThrottle = -ny / (rect.height * 0.32);
    };
    pad.addEventListener('pointerdown', (event) => {
      pointer = event.pointerId;
      pad.setPointerCapture(pointer);
      onDrive();
      update(event);
    });
    pad.addEventListener('pointermove', (event) => {
      if (event.pointerId === pointer) update(event);
    });
    const release = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      pointer = null;
      input.touchSteer = input.touchThrottle = 0;
      knob.style.transform = '';
    };
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);
    const brake = document.getElementById('touch-brake')!;
    brake.addEventListener('pointerdown', (event) => {
      brake.setPointerCapture(event.pointerId);
      input.touchHandbrake = true;
    });
    for (const type of ['pointerup', 'pointercancel']) brake.addEventListener(type, () => (input.touchHandbrake = false));
    document.getElementById('touch-drive')!.addEventListener('click', onDrive);
    document.getElementById('touch-view')!.addEventListener('click', onView);
  }
}
