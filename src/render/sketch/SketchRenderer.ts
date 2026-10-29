import * as THREE from 'three';
import fragmentShader from './sketch.frag?raw';

const PAPER = 0xf4efe4;
const INK = 0x2b2b33;

export type SketchStyle = 'pencil' | 'pen' | 'blueprint' | 'charcoal';

const PRESETS: Record<SketchStyle, { paper: number; ink: number; hatch: number; edge: number; wash: number }> = {
  pencil: { paper: PAPER, ink: INK, hatch: 1, edge: 1, wash: 1 },
  pen: { paper: 0xf7f3e9, ink: 0x18324a, hatch: 0.25, edge: 1.25, wash: 0.8 },
  blueprint: { paper: 0x163c59, ink: 0xb9e4ee, hatch: 0.45, edge: 1.1, wash: 0.25 },
  charcoal: { paper: 0xd8d2c7, ink: 0x17171b, hatch: 1.65, edge: 1.35, wash: 0.35 },
};

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Renders the scene into colour+depth and normal targets, then composites
 * outlines, tonal hatching and paper grain in one full-screen pass.
 */
export class SketchRenderer {
  enabled = true;
  style: SketchStyle = 'pencil';
  night = 0;
  private colorRT: THREE.WebGLRenderTarget | null = null;
  private normalRT: THREE.WebGLRenderTarget | null = null;
  private readonly normalMat = new THREE.MeshNormalMaterial();
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null },
        tNormal: { value: null },
        tDepth: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
        cameraNear: { value: 1 },
        cameraFar: { value: 1000 },
        isOrtho: { value: 1 },
        time: { value: 0 },
        lineScale: { value: 1 },
        depthThreshold: { value: 0.0012 },
        paper: { value: new THREE.Color(PAPER) },
        ink: { value: new THREE.Color(INK) },
        inverseProjection: { value: new THREE.Matrix4() },
        cameraWorld: { value: new THREE.Matrix4() },
        hatchScale: { value: 1 },
        edgeStrength: { value: 1 },
        colorWash: { value: 1 },
        motionAmount: { value: 0 },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
    renderer.setClearColor(PAPER, 1);
  }

  setStyle(style: SketchStyle): void {
    this.style = style;
    this.updatePalette();
  }

  setNight(amount: number): void {
    this.night = THREE.MathUtils.clamp(amount, 0, 1);
    this.updatePalette();
  }

  private updatePalette(): void {
    const preset = PRESETS[this.style];
    const u = this.material.uniforms;
    u.paper.value.setHex(preset.paper).lerp(new THREE.Color(0x17202b), this.night);
    u.ink.value.setHex(preset.ink).lerp(new THREE.Color(0xf4e8c8), this.night);
    u.hatchScale.value = preset.hatch;
    u.edgeStrength.value = preset.edge;
    u.colorWash.value = preset.wash;
    this.renderer.setClearColor(u.paper.value, 1);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    this.colorRT?.dispose();
    this.normalRT?.dispose();
    this.colorRT = new THREE.WebGLRenderTarget(w, h);
    this.colorRT.depthTexture = new THREE.DepthTexture(w, h);
    this.normalRT = new THREE.WebGLRenderTarget(w, h);
    const u = this.material.uniforms;
    u.tColor.value = this.colorRT.texture;
    u.tDepth.value = this.colorRT.depthTexture;
    u.tNormal.value = this.normalRT.texture;
    u.resolution.value.set(w, h);
    u.lineScale.value = pixelRatio;
  }

  render(
    scene: THREE.Scene,
    camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
    time: number,
    speed = 0,
  ): void {
    const r = this.renderer;
    r.shadowMap.needsUpdate = true;
    const paper = this.material.uniforms.paper.value as THREE.Color;
    if (!this.enabled || !this.colorRT || !this.normalRT) {
      r.setRenderTarget(null);
      r.render(scene, camera);
      return;
    }
    r.setRenderTarget(this.colorRT);
    r.setClearColor(paper, 1);
    r.render(scene, camera);

    scene.overrideMaterial = this.normalMat;
    r.setRenderTarget(this.normalRT);
    r.setClearColor(0x808080, 1);
    r.render(scene, camera);
    scene.overrideMaterial = null;
    r.setClearColor(paper, 1);

    const u = this.material.uniforms;
    const ortho = camera instanceof THREE.OrthographicCamera;
    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;
    u.isOrtho.value = ortho ? 1 : 0;
    u.depthThreshold.value = ortho ? 0.0012 : 0.04;
    u.inverseProjection.value.copy(camera.projectionMatrixInverse);
    u.cameraWorld.value.copy(camera.matrixWorld);
    u.motionAmount.value = THREE.MathUtils.smoothstep(speed, 9, 20);
    // Quantised time gives the hand-drawn "line boil".
    u.time.value = Math.floor(time * 8) / 8;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }
}
