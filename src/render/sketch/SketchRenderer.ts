import * as THREE from 'three';
import fragmentShader from './sketch.frag?raw';

const PAPER = 0xf4efe4;
const INK = 0x2b2b33;

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
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
    renderer.setClearColor(PAPER, 1);
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

  render(scene: THREE.Scene, camera: THREE.OrthographicCamera | THREE.PerspectiveCamera, time: number): void {
    const r = this.renderer;
    r.shadowMap.needsUpdate = true;
    if (!this.enabled || !this.colorRT || !this.normalRT) {
      r.setRenderTarget(null);
      r.render(scene, camera);
      return;
    }
    r.setRenderTarget(this.colorRT);
    r.setClearColor(PAPER, 1);
    r.render(scene, camera);

    scene.overrideMaterial = this.normalMat;
    r.setRenderTarget(this.normalRT);
    r.setClearColor(0x808080, 1);
    r.render(scene, camera);
    scene.overrideMaterial = null;
    r.setClearColor(PAPER, 1);

    const u = this.material.uniforms;
    const ortho = camera instanceof THREE.OrthographicCamera;
    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;
    u.isOrtho.value = ortho ? 1 : 0;
    u.depthThreshold.value = ortho ? 0.0012 : 0.04;
    // Quantised time gives the hand-drawn "line boil".
    u.time.value = Math.floor(time * 8) / 8;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }
}
