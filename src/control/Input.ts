const CAPTURED = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'Tab',
]);

function isFormField(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
}

export class Input {
  private readonly down = new Set<string>();

  constructor(onAction: (code: string) => void) {
    window.addEventListener('keydown', (e) => {
      if (isFormField(e.target)) return;
      if (CAPTURED.has(e.code)) e.preventDefault();
      this.down.add(e.code);
      if (!e.repeat) onAction(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  isDown(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  get throttle(): number {
    return (this.isDown('KeyW', 'ArrowUp') ? 1 : 0) - (this.isDown('KeyS', 'ArrowDown') ? 1 : 0);
  }

  get steer(): number {
    return (this.isDown('KeyD', 'ArrowRight') ? 1 : 0) - (this.isDown('KeyA', 'ArrowLeft') ? 1 : 0);
  }

  get handbrake(): boolean {
    return this.isDown('Space');
  }
}
