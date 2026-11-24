import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PlanetSummary } from '../types/meridian';

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface GoldbergFacet {
  id: number;
  isPentagon: boolean;
  center: Vec3;
  corners: Vec3[];
  normal: Vec3;
  biomeName: string;
  rgb: [number, number, number];
  buildable: boolean;
  elev: number;
}

interface PlanetProfile {
  seed: number;
  seaOffset: number;
  tempBias: number;
  moistBias: number;
  tiltDeg: number;
  rotDays: number;
  atmoColor: string;
  mode: 'volcanic' | 'terrestrial' | 'icy';
}

export const PLANET_ROTATION_DAYS: Record<string, number> = {
  P1: 2.0,
  P2: 1.0,
  P3: 0.75,
};

const PROFILES: Record<string, PlanetProfile> = {
  P1: {
    seed: 10131,
    seaOffset: -0.3,
    tempBias: 0.45,
    moistBias: -0.45,
    tiltDeg: 10,
    rotDays: PLANET_ROTATION_DAYS.P1,
    atmoColor: 'rgba(234, 120, 62, 0.22)',
    mode: 'volcanic',
  },
  P2: {
    seed: 20263,
    seaOffset: 0.04,
    tempBias: 0.03,
    moistBias: 0.14,
    tiltDeg: 22,
    rotDays: PLANET_ROTATION_DAYS.P2,
    atmoColor: 'rgba(56, 189, 248, 0.25)',
    mode: 'terrestrial',
  },
  P3: {
    seed: 30397,
    seaOffset: -0.02,
    tempBias: -0.45,
    moistBias: -0.1,
    tiltDeg: 17,
    rotDays: PLANET_ROTATION_DAYS.P3,
    atmoColor: 'rgba(125, 211, 252, 0.22)',
    mode: 'icy',
  },
};

function norm3(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function mulberry32(a: number) {
  let state = a >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise3D(seed: number) {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a: number, b: number, t: number) => a + t * (b - a);
  const grad = (hash: number, x: number, y: number, z: number) => {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  };

  function noise(x: number, y: number, z: number) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const fz = z - Math.floor(z);
    const u = fade(fx);
    const v = fade(fy);
    const w = fade(fz);
    const A = perm[X] + Y;
    const AA = perm[A] + Z;
    const AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y;
    const BA = perm[B] + Z;
    const BB = perm[B + 1] + Z;
    return lerp(
      lerp(
        lerp(grad(perm[AA], fx, fy, fz), grad(perm[BA], fx - 1, fy, fz), u),
        lerp(grad(perm[AB], fx, fy - 1, fz), grad(perm[BB], fx - 1, fy - 1, fz), u),
        v,
      ),
      lerp(
        lerp(grad(perm[AA + 1], fx, fy, fz - 1), grad(perm[BA + 1], fx - 1, fy, fz - 1), u),
        lerp(grad(perm[AB + 1], fx, fy - 1, fz - 1), grad(perm[BB + 1], fx - 1, fy - 1, fz - 1), u),
        v,
      ),
      w,
    );
  }

  return (x: number, y: number, z: number, octaves = 4) => {
    let sum = 0;
    let amp = 0.5;
    let freq = 1.0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2.05;
    }
    return sum / norm;
  };
}

function buildGoldbergFacets(N: number, profile: PlanetProfile): GoldbergFacet[] {
  const phi = (1 + Math.sqrt(5)) / 2;
  const rawVerts = [
    [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
    [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
    [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
  ].map(([x, y, z]) => norm3({ x, y, z }));

  const icoFaces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  const vertMap = new Map<string, number>();
  const verts: Vec3[] = [];
  const vertToTris: number[][] = [];

  const getVert = (v: Vec3) => {
    const u = norm3(v);
    const key = `${Math.round(u.x * 1e4)},${Math.round(u.y * 1e4)},${Math.round(u.z * 1e4)}`;
    const found = vertMap.get(key);
    if (found !== undefined) return found;
    const idx = verts.length;
    verts.push(u);
    vertToTris.push([]);
    vertMap.set(key, idx);
    return idx;
  };

  const triCentroids: Vec3[] = [];
  for (const [ia, ib, ic] of icoFaces) {
    const va = rawVerts[ia];
    const vb = rawVerts[ib];
    const vc = rawVerts[ic];
    const grid: number[][] = [];
    for (let i = 0; i <= N; i++) {
      grid[i] = [];
      for (let j = 0; j <= N - i; j++) {
        const k = N - i - j;
        grid[i][j] = getVert({
          x: (va.x * k + vb.x * i + vc.x * j) / N,
          y: (va.y * k + vb.y * i + vc.y * j) / N,
          z: (va.z * k + vb.z * i + vc.z * j) / N,
        });
      }
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N - i; j++) {
        const addTri = (v1: number, v2: number, v3: number) => {
          const tIdx = triCentroids.length;
          triCentroids.push(
            norm3({
              x: (verts[v1].x + verts[v2].x + verts[v3].x) / 3,
              y: (verts[v1].y + verts[v2].y + verts[v3].y) / 3,
              z: (verts[v1].z + verts[v2].z + verts[v3].z) / 3,
            }),
          );
          vertToTris[v1].push(tIdx);
          vertToTris[v2].push(tIdx);
          vertToTris[v3].push(tIdx);
        };
        addTri(grid[i][j], grid[i + 1][j], grid[i][j + 1]);
        if (i + j + 1 < N) addTri(grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
      }
    }
  }

  const elevNoise = makeNoise3D(profile.seed);
  const moistNoise = makeNoise3D(profile.seed + 1013);
  const ridgeNoise = makeNoise3D(profile.seed + 4099);

  const refUp: Vec3 = { x: 0, y: 1, z: 0 };
  const refAlt: Vec3 = { x: 1, y: 0, z: 0 };

  const facets: GoldbergFacet[] = [];
  for (let vIdx = 0; vIdx < verts.length; vIdx++) {
    const center = verts[vIdx];
    const ref = Math.abs(dot3(center, refUp)) > 0.9 ? refAlt : refUp;
    const t1 = norm3(cross3(ref, center));
    const t2 = norm3(cross3(center, t1));
    const sortedCorners = vertToTris[vIdx]
      .map((tIdx) => {
        const c = triCentroids[tIdx];
        const d = sub3(c, center);
        return { vec: c, angle: Math.atan2(dot3(d, t2), dot3(d, t1)) };
      })
      .sort((a, b) => a.angle - b.angle);

    const { x, y, z } = center;
    const cont = elevNoise(x * 1.4, y * 1.4, z * 1.4, 4);
    const ridge = 1.0 - Math.abs(ridgeNoise(x * 2.4, y * 2.4, z * 2.4, 3));
    const elev = cont + (ridge - 0.55) * 0.28 - profile.seaOffset;
    const lat = Math.abs(y);
    const dryBelt = Math.exp(-Math.pow((lat - 0.38) / 0.16, 2)) * 0.28;
    const moist = moistNoise(x * 2.0, y * 2.0, z * 2.0, 3) + 0.5 - dryBelt + profile.moistBias;
    const tempC = Math.round(28 - lat * 52 - Math.max(0, elev) * 35 + profile.tempBias * 45);

    let biomeName = '温带平原';
    let rgb: [number, number, number] = [90, 164, 79];
    let buildable = true;

    if (profile.mode === 'volcanic') {
      if (elev < -0.04) {
        biomeName = '玄武熔岩池';
        rgb = [138, 52, 28];
        buildable = false;
      } else if (elev > 0.32) {
        biomeName = '富矿山脊';
        rgb = [132, 114, 102];
      } else if (ridge > 0.72) {
        biomeName = '铜铁露头';
        rgb = [194, 116, 56];
      } else {
        biomeName = '炽热岩原';
        rgb = [98, 72, 60];
      }
    } else if (profile.mode === 'icy') {
      if (elev < -0.05) {
        biomeName = '冰封冻海';
        rgb = [43, 78, 107];
        buildable = false;
      } else if (elev > 0.3) {
        biomeName = '极地冰峰';
        rgb = [226, 236, 244];
      } else if (elev > 0.16) {
        biomeName = '冷岩山脉';
        rgb = [108, 122, 137];
      } else {
        biomeName = '冻土冰原';
        rgb = [155, 183, 201];
      }
    } else {
      if (elev < -0.06) {
        biomeName = '深海';
        rgb = [19, 64, 108];
        buildable = false;
      } else if (elev < 0.0) {
        biomeName = '浅海大陆架';
        rgb = [33, 110, 166];
        buildable = false;
      } else if (elev > 0.36 || (elev > 0.25 && tempC < -5)) {
        biomeName = tempC < -8 ? '雪峰极巅' : '高山矿脉';
        rgb = tempC < -8 ? [224, 232, 240] : [110, 106, 100];
      } else if (tempC < -6) {
        biomeName = '冻土苔原';
        rgb = [155, 183, 201];
      } else if (moist < 0.3) {
        biomeName = '荒漠戈壁';
        rgb = [208, 159, 86];
      } else if (tempC > 16 && moist > 0.58) {
        biomeName = '热带雨林';
        rgb = [31, 122, 62];
      } else {
        biomeName = '温带平原';
        rgb = [88, 160, 78];
      }
    }

    const rScale = buildable ? 1.0 + Math.max(0.008, elev * 0.12) : 1.0;
    const corners = sortedCorners.map((c) => ({
      x: c.vec.x * rScale,
      y: c.vec.y * rScale,
      z: c.vec.z * rScale,
    }));
    const scaledCenter: Vec3 = {
      x: center.x * rScale,
      y: center.y * rScale,
      z: center.z * rScale,
    };

    facets.push({
      id: vIdx + 1,
      isPentagon: corners.length === 5,
      center: scaledCenter,
      corners,
      normal: center,
      biomeName,
      rgb,
      buildable,
      elev: +elev.toFixed(2),
    });
  }

  return facets;
}

function planetToWorld(p: Vec3, spinYaw: number, tiltRad: number): Vec3 {
  // 1) Spin around local Y (planetary axial rotation only)
  const cy = Math.cos(spinYaw);
  const sy = Math.sin(spinYaw);
  const x1 = p.x * cy + p.z * sy;
  const y1 = p.y;
  const z1 = -p.x * sy + p.z * cy;

  // 2) Axial tilt around Z
  const ct = Math.cos(tiltRad);
  const st = Math.sin(tiltRad);
  return {
    x: x1 * ct - y1 * st,
    y: x1 * st + y1 * ct,
    z: z1,
  };
}

function worldToCamera(p: Vec3, camYaw: number, camPitch: number): Vec3 {
  // 1) Orbit camera horizontally around world Y
  const cy = Math.cos(camYaw);
  const sy = Math.sin(camYaw);
  const x1 = p.x * cy + p.z * sy;
  const y1 = p.y;
  const z1 = -p.x * sy + p.z * cy;

  // 2) Pitch camera around X
  const cp = Math.cos(camPitch);
  const sp = Math.sin(camPitch);
  return {
    x: x1,
    y: y1 * cp - z1 * sp,
    z: y1 * sp + z1 * cp,
  };
}

function rotatePlanetPoint(
  p: Vec3,
  spinYaw: number,
  tiltRad: number,
  camYaw: number,
  camPitch: number,
): Vec3 {
  return worldToCamera(planetToWorld(p, spinYaw, tiltRad), camYaw, camPitch);
}

function hashPlanetId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 10131;
}

function resolvePlanetProfile(planetId: string, planet?: PlanetSummary): PlanetProfile {
  if (!planet || (planet.visual_seed === undefined && planet.solar_mult === undefined)) {
    return PROFILES[planetId] ?? PROFILES.P2;
  }
  const solar = planet.solar_mult ?? 1.0;
  const ocean = planet.ocean_ratio ?? 0.25;
  const water = planet.water_mult ?? 1.0;
  const hab = planet.habitability ?? 0.5;
  const mode: PlanetProfile['mode'] =
    solar > 1.35 && ocean < 0.18
      ? 'volcanic'
      : solar < 0.65 && hab < 0.55
        ? 'icy'
        : 'terrestrial';
  const seed = (planet.visual_seed && planet.visual_seed > 0) ? planet.visual_seed : hashPlanetId(planetId);
  const seaOffset = mode === 'volcanic' ? -0.3 + ocean * 0.4 : (ocean - 0.32) * 0.65;
  const tempBias = Math.max(-0.6, Math.min(0.6, (solar - 1.0) * 0.55));
  const moistBias = Math.max(-0.55, Math.min(0.55, (water - 1.0) * 0.45));
  const tiltDeg = 8 + (seed % 20);
  const rotDays = planet.rotation_days && planet.rotation_days > 0
    ? planet.rotation_days
    : (PLANET_ROTATION_DAYS[planetId] ?? 3.5);
  const atmoColor =
    mode === 'volcanic'
      ? 'rgba(234, 120, 62, 0.22)'
      : mode === 'icy'
        ? 'rgba(125, 211, 252, 0.22)'
        : hab >= 0.65
          ? 'rgba(56, 189, 248, 0.26)'
          : 'rgba(148, 163, 184, 0.20)';

  return {
    seed,
    seaOffset,
    tempBias,
    moistBias,
    tiltDeg,
    rotDays,
    atmoColor,
    mode,
  };
}

export interface Planet3DCanvasProps {
  planetId: string;
  planet?: PlanetSummary;
  tick: number;
  paused: boolean;
  tickMs: number;
  ticksPerDay: number;
  onOpenLand?: () => void;
}

export const Planet3DCanvas: React.FC<Planet3DCanvasProps> = ({
  planetId,
  planet,
  tick,
  paused,
  tickMs,
  ticksPerDay,
  onOpenLand,
}) => {
  const profile = useMemo(
    () => resolvePlanetProfile(planetId, planet),
    [
      planetId,
      planet?.visual_seed,
      planet?.solar_mult,
      planet?.water_mult,
      planet?.ocean_ratio,
      planet?.habitability,
      planet?.rotation_days,
    ],
  );
  const facets = useMemo(() => buildGoldbergFacets(4, profile), [profile]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const userYawOffsetRef = useRef<number>(0.6);
  const pitchRef = useRef<number>(0.28);
  const simRef = useRef<{
    tick: number;
    paused: boolean;
    tickMs: number;
    ticksPerDay: number;
    tickAtMs: number;
  }>({
    tick,
    paused,
    tickMs: Math.max(100, tickMs || 2000),
    ticksPerDay: Math.max(1, ticksPerDay || 24),
    tickAtMs: performance.now(),
  });

  useEffect(() => {
    simRef.current = {
      tick,
      paused,
      tickMs: Math.max(100, tickMs || 2000),
      ticksPerDay: Math.max(1, ticksPerDay || 24),
      tickAtMs: performance.now(),
    };
  }, [tick, paused, tickMs, ticksPerDay]);

  const draggingRef = useRef<{ active: boolean; x: number; y: number; moved: number }>({
    active: false,
    x: 0,
    y: 0,
    moved: 0,
  });
  const selectedIdRef = useRef<number | null>(null);
  const lastScreenPolysRef = useRef<
    Array<{ facet: GoldbergFacet; pts: Array<[number, number]> }>
  >([]);
  const [selectedInfo, setSelectedInfo] = useState<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = null;
    setSelectedInfo(null);
  }, [planetId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;

    const renderFrame = () => {
      const parent = canvas.parentElement;
      if (parent) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(180, parent.clientWidth);
        const h = Math.max(160, parent.clientHeight);
        if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
          canvas.width = Math.floor(w * dpr);
          canvas.height = Math.floor(h * dpr);
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, w, h);

          // Sync rotation angle to planet rotation period, ticks_per_day, tick_ms, and paused state
          const sim = simRef.current;
          const frac = sim.paused
            ? 0
            : Math.min(1, Math.max(0, (performance.now() - sim.tickAtMs) / sim.tickMs));
          const rotTicks = Math.max(1, sim.ticksPerDay * profile.rotDays);
          const spinYaw = (((sim.tick + frac) / rotTicks) * Math.PI * 2) % (Math.PI * 2);

          const cx = w / 2;
          const cy = h / 2 + 2;
          const radius = Math.min(w, h) * 0.36;
          const tiltRad = (profile.tiltDeg * Math.PI) / 180;
          const camYaw = userYawOffsetRef.current;
          const camPitch = pitchRef.current;
          // Sun stays fixed in world space so orbiting/dragging the camera never shifts the terminator
          const sunWorld = norm3({ x: 0.72, y: 0.42, z: 0.55 });
          const sunDir = worldToCamera(sunWorld, camYaw, camPitch);

          // Subtle polar axis spine
          const northPole = rotatePlanetPoint({ x: 0, y: 1.2, z: 0 }, spinYaw, tiltRad, camYaw, camPitch);
          const southPole = rotatePlanetPoint({ x: 0, y: -1.2, z: 0 }, spinYaw, tiltRad, camYaw, camPitch);
          ctx.strokeStyle = 'rgba(203, 213, 225, 0.28)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx + southPole.x * radius, cy - southPole.y * radius);
          ctx.lineTo(cx + northPole.x * radius, cy - northPole.y * radius);
          ctx.stroke();

          // Atmosphere glow behind globe
          const grad = ctx.createRadialGradient(
            cx + sunDir.x * radius * 0.22,
            cy - sunDir.y * radius * 0.22,
            radius * 0.4,
            cx,
            cy,
            radius * 1.18,
          );
          grad.addColorStop(0, 'rgba(0,0,0,0)');
          grad.addColorStop(0.84, profile.atmoColor);
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(cx, cy, radius * 1.18, 0, Math.PI * 2);
          ctx.fill();

          // Project visible Goldberg facets & sort back-to-front
          const visible: Array<{
            facet: GoldbergFacet;
            depth: number;
            light: number;
            pts: Array<[number, number]>;
          }> = [];

          for (const f of facets) {
            const rc = rotatePlanetPoint(f.center, spinYaw, tiltRad, camYaw, camPitch);
            const rn = rotatePlanetPoint(f.normal, spinYaw, tiltRad, camYaw, camPitch);
            if (rn.z <= -0.05) continue;
            const light = Math.max(0.24, 0.28 + Math.max(0, dot3(rn, sunDir)) * 0.92);
            const pts: Array<[number, number]> = f.corners.map((c) => {
              const p = rotatePlanetPoint(c, spinYaw, tiltRad, camYaw, camPitch);
              return [cx + p.x * radius, cy - p.y * radius];
            });
            visible.push({ facet: f, depth: rc.z, light, pts });
          }

          visible.sort((a, b) => a.depth - b.depth);
          lastScreenPolysRef.current = visible.map((v) => ({ facet: v.facet, pts: v.pts }));

          for (const item of visible) {
            const { facet, light, pts } = item;
            const [r0, g0, b0] = facet.rgb;
            const r = Math.min(255, Math.round(r0 * light));
            const g = Math.min(255, Math.round(g0 * light));
            const b = Math.min(255, Math.round(b0 * light));
            const isSel = selectedIdRef.current === facet.id;

            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) {
              ctx.lineTo(pts[i][0], pts[i][1]);
            }
            ctx.closePath();

            ctx.fillStyle = isSel ? 'rgba(56, 189, 248, 0.92)' : `rgb(${r},${g},${b})`;
            ctx.fill();

            if (facet.isPentagon) {
              ctx.strokeStyle = 'rgba(242, 204, 96, 0.72)';
              ctx.lineWidth = 1.1;
            } else if (isSel) {
              ctx.strokeStyle = '#ffffff';
              ctx.lineWidth = 1.4;
            } else {
              ctx.strokeStyle = 'rgba(13, 17, 23, 0.45)';
              ctx.lineWidth = 0.75;
            }
            ctx.stroke();
          }
        }
      }
      raf = window.requestAnimationFrame(renderFrame);
    };

    raf = window.requestAnimationFrame(renderFrame);
    return () => window.cancelAnimationFrame(raf);
  }, [facets, profile]);

  const pointInPoly = (x: number, y: number, pts: Array<[number, number]>) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0];
      const yi = pts[i][1];
      const xj = pts[j][0];
      const yj = pts[j][1];
      const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  };

  return (
    <div className="relative w-full h-full bg-[#191f27] select-none overflow-hidden">
      {onOpenLand && (
        <button
          onClick={onOpenLand}
          className="absolute top-1.5 left-2.5 z-10 pill-btn py-0 text-[10px] text-sky-200 border-sky-500/40 bg-[#202732]/85 hover:bg-sky-500/20"
        >
          查看公开地块
        </button>
      )}
      <div className="absolute top-1.5 right-2.5 z-10 pointer-events-none text-[10px] text-slate-400">
        提示：左/右键拖动以旋转
      </div>
      {selectedInfo && (
        <div className="absolute bottom-2 left-2.5 z-10 flex items-center gap-2 px-2 py-0.5 rounded bg-[#202732]/90 border border-sky-500/30 text-[10px] text-sky-200 mono">
          <span>{selectedInfo}</span>
          {onOpenLand && (
            <button
              onClick={onOpenLand}
              className="text-emerald-300 hover:underline pointer-events-auto"
            >
              打开地块窗口 →
            </button>
          )}
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-grab active:cursor-grabbing block"
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
          draggingRef.current = { active: true, x: e.clientX, y: e.clientY, moved: 0 };
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current.active) return;
          const dx = e.clientX - draggingRef.current.x;
          const dy = e.clientY - draggingRef.current.y;
          draggingRef.current.moved += Math.hypot(dx, dy);
          draggingRef.current.x = e.clientX;
          draggingRef.current.y = e.clientY;
          userYawOffsetRef.current += dx * 0.012;
          pitchRef.current = Math.max(-1.25, Math.min(1.25, pitchRef.current + dy * 0.012));
        }}
        onPointerUp={(e) => {
          const moved = draggingRef.current.moved;
          draggingRef.current.active = false;
          if (moved < 5) {
            const rect = e.currentTarget.getBoundingClientRect();
            const lx = e.clientX - rect.left;
            const ly = e.clientY - rect.top;
            const polys = lastScreenPolysRef.current;
            for (let i = polys.length - 1; i >= 0; i--) {
              if (pointInPoly(lx, ly, polys[i].pts)) {
                const f = polys[i].facet;
                selectedIdRef.current = f.id;
                setSelectedInfo(
                  `#${f.id}${f.isPentagon ? ' ★' : ''} · ${f.biomeName} · 海拔 ${f.elev >= 0 ? '+' : ''}${f.elev}`,
                );
                break;
              }
            }
          }
        }}
        onPointerCancel={() => {
          draggingRef.current.active = false;
        }}
      />
    </div>
  );
};
