uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 resolution;
uniform float cameraNear;
uniform float cameraFar;
uniform float isOrtho;
uniform float time;
uniform float lineScale;
uniform float depthThreshold;
uniform vec3 paper;
uniform vec3 ink;
varying vec2 vUv;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float viewDepth(float d) {
  if (isOrtho > 0.5) return cameraNear + d * (cameraFar - cameraNear);
  float z = d * 2.0 - 1.0;
  return 2.0 * cameraNear * cameraFar / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
}

// Linear in screen space across any plane (z for ortho, 1/z for perspective),
// so its Laplacian is zero on flat ground and spikes at silhouettes and creases.
float depthMetric(vec2 uv) {
  float z = viewDepth(texture2D(tDepth, uv).x);
  return isOrtho > 0.5 ? z : 1.0 / z;
}

vec3 normalAt(vec2 uv) {
  return texture2D(tNormal, uv).xyz * 2.0 - 1.0;
}

float edgeAt(vec2 uv, vec2 px) {
  vec2 dx = vec2(px.x, 0.0);
  vec2 dy = vec2(0.0, px.y);
  float c = depthMetric(uv);
  float lap = abs(depthMetric(uv - dx) + depthMetric(uv + dx) - 2.0 * c)
            + abs(depthMetric(uv - dy) + depthMetric(uv + dy) - 2.0 * c);
  float de = smoothstep(depthThreshold, depthThreshold * 2.5, lap / max(abs(c), 1e-6));

  vec3 n0 = normalAt(uv);
  float nd = 4.0 - dot(n0, normalAt(uv - dx)) - dot(n0, normalAt(uv + dx))
                 - dot(n0, normalAt(uv - dy)) - dot(n0, normalAt(uv + dy));
  float ne = smoothstep(0.35, 0.9, nd);
  return max(de, ne);
}

float hatch(vec2 p, float ang, float spacing) {
  vec2 dir = vec2(cos(ang), sin(ang));
  float c = dot(p, dir) + (noise(p * 0.015) - 0.5) * 6.0;
  float along = dot(p, vec2(-dir.y, dir.x));
  float f = abs(fract(c / spacing) - 0.5) * spacing;
  float line = 1.0 - smoothstep(0.35, 1.1, f);
  float gaps = smoothstep(0.2, 0.55, noise(vec2(along * 0.04, floor(c / spacing) * 7.13)));
  return line * gaps;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 px = lineScale / resolution;
  vec2 wob = vec2(noise(fc * 0.02 / lineScale + time * 3.1),
                  noise(fc * 0.02 / lineScale + 31.7 + time * 3.1)) - 0.5;
  vec2 uv = vUv + wob * 2.5 * px;

  bool bg = texture2D(tDepth, vUv).x >= 0.99999;
  vec3 col = pow(max(texture2D(tColor, vUv).rgb, 0.0), vec3(1.0 / 2.2));
  float tone = 1.0 - dot(col, vec3(0.299, 0.587, 0.114));

  vec2 p = fc / lineScale + vec2(hash(vec2(time, 1.3)), hash(vec2(time, 7.9))) * 1.5;
  float h = 0.0;
  if (!bg) {
    h = max(h, hatch(p, 0.79, 6.0) * smoothstep(0.10, 0.28, tone));
    h = max(h, hatch(p, -0.79, 6.0) * smoothstep(0.30, 0.48, tone));
    h = max(h, hatch(p, 0.0, 4.5) * smoothstep(0.48, 0.66, tone));
    h = max(h, hatch(p, 1.571, 3.5) * smoothstep(0.66, 0.82, tone));
  }
  float e = edgeAt(uv, px);

  float grain = noise(fc * 0.7) * 0.5 + noise(fc * 0.08) * 0.5;
  vec3 base = paper * (0.95 + 0.05 * grain);
  // Saturated surfaces keep a coloured-pencil wash so cars and lights stay readable.
  float sat = max(col.r, max(col.g, col.b)) - min(col.r, min(col.g, col.b));
  float tint = bg ? 0.0 : smoothstep(0.12, 0.4, sat) * (0.55 + 0.45 * hatch(p * 0.8, 0.4, 3.0));
  vec3 washed = mix(base, mix(base, col, 0.85), tint);

  float inkAmt = clamp(max(e * 0.92, h * 0.6), 0.0, 1.0);
  vec3 outc = mix(washed, ink, inkAmt);
  outc *= 1.0 - 0.22 * smoothstep(0.35, 0.85, length(vUv - 0.5));
  gl_FragColor = vec4(outc, 1.0);
}
