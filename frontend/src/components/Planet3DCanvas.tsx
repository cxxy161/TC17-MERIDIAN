import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PlanetSummary, VisibleFlight } from '../types/meridian';
import { SmoothTickClock } from '../utils/smoothClock';

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
  flights?: VisibleFlight[];
  onOpenLand?: () => void;
}

function isOccludedBySphere(p: Vec3): boolean {
  return p.z < 0 && p.x * p.x + p.y * p.y < 1.0;
}

function drawGeometricShip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angleRad: number,
  size: VisibleFlight['size'],
  isMine: boolean,
  scale = 1,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angleRad);
  ctx.scale(scale, scale);

  if (!isMine) {
    ctx.beginPath();
    ctx.moveTo(2.8, 0);
    ctx.lineTo(0, -1.4);
    ctx.lineTo(-2.2, 0);
    ctx.lineTo(0, 1.4);
    ctx.closePath();
    ctx.fillStyle = 'rgba(148, 163, 184, 0.72)';
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.arc(0, 0, size === 'large' ? 7 : 5.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(34, 211, 238, 0.14)';
  ctx.fill();

  ctx.beginPath();
  if (size === 'small') {
    ctx.moveTo(4.4, 0);
    ctx.lineTo(-3.2, -2.2);
    ctx.lineTo(-1.8, 0);
    ctx.lineTo(-3.2, 2.2);
  } else if (size === 'medium') {
    ctx.moveTo(5.4, 0);
    ctx.lineTo(-3.6, -2.8);
    ctx.lineTo(-2.0, 0);
    ctx.lineTo(-3.6, 2.8);
  } else {
    ctx.moveTo(6.5, 0);
    ctx.lineTo(-4.0, -3.4);
    ctx.lineTo(-2.2, 0);
    ctx.lineTo(-4.0, 3.4);
  }
  ctx.closePath();

  ctx.fillStyle = '#22d3ee';
  ctx.fill();
  ctx.strokeStyle = '#cffafe';
  ctx.lineWidth = 0.6;
  ctx.stroke();
  ctx.restore();
}

function drawOrbitalStation(ctx: CanvasRenderingContext2D, sx: number, sy: number, label: string) {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.beginPath();
  ctx.moveTo(0, -6);
  ctx.lineTo(6, 0);
  ctx.lineTo(0, 6);
  ctx.lineTo(-6, 0);
  ctx.closePath();
  ctx.fillStyle = '#0f172a';
  ctx.fill();
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.fillStyle = '#38bdf8';
  ctx.fillRect(-1.8, -1.8, 3.6, 3.6);
  ctx.restore();

  ctx.fillStyle = 'rgba(125, 211, 252, 0.82)';
  ctx.font = '9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(label, sx + 8, sy + 3);
}

export const Planet3DCanvas: React.FC<Planet3DCanvasProps> = ({
  planetId,
  planet,
  tick,
  paused,
  tickMs,
  ticksPerDay,
  flights = [],
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
  const flightsRef = useRef<VisibleFlight[]>(flights);
  flightsRef.current = flights;
  const planetIdRef = useRef<string>(planetId);
  planetIdRef.current = planetId;
  const clockRef = useRef<SmoothTickClock>(new SmoothTickClock());
  clockRef.current.sync(tick, tickMs, paused);
  const ticksPerDayRef = useRef<number>(Math.max(1, ticksPerDay || 24));
  ticksPerDayRef.current = Math.max(1, ticksPerDay || 24);

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

          // Sync rotation angle & flights to monotonic SmoothTickClock (no per-tick stutter)
          const simTime = clockRef.current.advance();
          const rotTicks = Math.max(1, ticksPerDayRef.current * profile.rotDays);
          const spinYaw = ((simTime / rotTicks) * Math.PI * 2) % (Math.PI * 2);

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

          // Compute planetary orbit ring + station ST:<planetId> + local geometric ship flights
          const pid = planetIdRef.current;
          const stId = `ST:${pid}`;
          const orbitR = 1.32;
          const stationAngle = (simTime * 0.04) % (Math.PI * 2);
          const stationLocal: Vec3 = {
            x: orbitR * Math.cos(stationAngle),
            y: 0,
            z: orbitR * Math.sin(stationAngle),
          };
          const stationCam = rotatePlanetPoint(stationLocal, 0, tiltRad, camYaw, camPitch);
          const stationScreenX = cx + stationCam.x * radius;
          const stationScreenY = cy - stationCam.y * radius;

          const RING_SEGS = 64;
          const ringPts: Vec3[] = [];
          for (let s = 0; s <= RING_SEGS; s++) {
            const a = (s / RING_SEGS) * Math.PI * 2;
            ringPts.push(
              rotatePlanetPoint(
                { x: orbitR * Math.cos(a), y: 0, z: orbitR * Math.sin(a) },
                0,
                tiltRad,
                camYaw,
                camPitch,
              ),
            );
          }

          interface RenderShip3D {
            x: number;
            y: number;
            angle: number;
            trailPts: Array<[number, number]>;
            size: VisibleFlight['size'];
            isMine: boolean;
            back: boolean;
            scale: number;
          }
          const renderShips: RenderShip3D[] = [];
          for (const f of flightsRef.current) {
            const touchesLocal =
              f.from === pid || f.to === pid || f.from === stId || f.to === stId;
            if (!touchesLocal) continue;
            const span = Math.max(1, f.arrival_tick - f.launch_tick);
            const tRaw = (simTime - f.launch_tick) / span;
            const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
            const isShuttle =
              (f.from === pid && f.to === stId) || (f.from === stId && f.to === pid);

            if (isShuttle) {
              const isLaunch = f.to === stId;
              const lon = ((f.key % 360) * Math.PI) / 180;
              const lat = ((((f.key >> 9) % 90) - 45) * Math.PI) / 180;
              const padLocal: Vec3 = {
                x: Math.cos(lat) * Math.cos(lon),
                y: Math.sin(lat),
                z: Math.cos(lat) * Math.sin(lon),
              };
              const padCam = rotatePlanetPoint(padLocal, spinYaw, tiltRad, camYaw, camPitch);
              const evalShuttle = (u: number): Vec3 => {
                const s = isLaunch ? u : 1 - u;
                const dir = norm3({
                  x: padCam.x * (1 - s) + stationCam.x * s,
                  y: padCam.y * (1 - s) + stationCam.y * s,
                  z: padCam.z * (1 - s) + stationCam.z * s,
                });
                const r = 1.02 + (orbitR - 1.02) * s + Math.sin(Math.PI * s) * 0.12;
                return { x: dir.x * r, y: dir.y * r, z: dir.z * r };
              };
              const pCur = evalShuttle(t);
              if (isOccludedBySphere(pCur)) continue;
              const pNext = evalShuttle(Math.min(1, t + 0.03));
              const sx = cx + pCur.x * radius;
              const sy = cy - pCur.y * radius;
              const nx = cx + pNext.x * radius;
              const ny = cy - pNext.y * radius;
              const angle = Math.atan2(ny - sy, nx - sx);
              const trailPts: Array<[number, number]> = [];
              for (let k = 4; k >= 0; k--) {
                const tk = Math.max(0, t - k * 0.045);
                const pk = evalShuttle(tk);
                if (!isOccludedBySphere(pk)) {
                  trailPts.push([cx + pk.x * radius, cy - pk.y * radius]);
                }
              }
              renderShips.push({
                x: sx,
                y: sy,
                angle,
                trailPts,
                size: f.size,
                isMine: f.is_mine,
                back: pCur.z < 0,
                scale: f.is_mine ? 0.95 : 0.78,
              });
            } else {
              // Departing from or arriving at ST:<pid> along an orbital transfer leg
              const isDepart = f.from === stId;
              const windowProgress = isDepart
                ? Math.min(1, t / 0.45)
                : Math.max(0, (t - 0.55) / 0.45);
              if (isDepart && t > 0.48) continue;
              if (!isDepart && t < 0.52) continue;
              const s = isDepart ? windowProgress : 1 - windowProgress;
              const radial = norm3(stationCam);
              const tangent = norm3({ x: -radial.z, y: radial.y * 0.25, z: radial.x });
              const evalDeep = (u: number): Vec3 => ({
                x: stationCam.x + (radial.x * 0.42 + tangent.x * 0.28) * u,
                y: stationCam.y + (radial.y * 0.42 + tangent.y * 0.28) * u,
                z: stationCam.z + (radial.z * 0.42 + tangent.z * 0.28) * u,
              });
              const pCur = evalDeep(s);
              if (isOccludedBySphere(pCur)) continue;
              const pAhead = evalDeep(isDepart ? Math.min(1, s + 0.04) : Math.max(0, s - 0.04));
              const sx = cx + pCur.x * radius;
              const sy = cy - pCur.y * radius;
              const nx = cx + pAhead.x * radius;
              const ny = cy - pAhead.y * radius;
              const angle = Math.atan2(ny - sy, nx - sx);
              const trailPts: Array<[number, number]> = [];
              for (let k = 3; k >= 0; k--) {
                const uk = isDepart
                  ? Math.max(0, s - k * 0.06)
                  : Math.min(1, s + k * 0.06);
                const pk = evalDeep(uk);
                if (!isOccludedBySphere(pk)) {
                  trailPts.push([cx + pk.x * radius, cy - pk.y * radius]);
                }
              }
              renderShips.push({
                x: sx,
                y: sy,
                angle,
                trailPts,
                size: f.size,
                isMine: f.is_mine,
                back: pCur.z < 0,
                scale: f.is_mine ? 0.9 : 0.72,
              });
            }
          }

          const drawOrbitLayer = (front: boolean) => {
            ctx.save();
            ctx.setLineDash([3, 4]);
            ctx.strokeStyle = front ? 'rgba(56, 189, 248, 0.34)' : 'rgba(56, 189, 248, 0.14)';
            ctx.lineWidth = 1;
            for (let s = 0; s < RING_SEGS; s++) {
              const p0 = ringPts[s];
              const p1 = ringPts[s + 1];
              const isFrontSeg = (p0.z + p1.z) * 0.5 >= 0;
              if (isFrontSeg !== front) continue;
              ctx.beginPath();
              ctx.moveTo(cx + p0.x * radius, cy - p0.y * radius);
              ctx.lineTo(cx + p1.x * radius, cy - p1.y * radius);
              ctx.stroke();
            }
            ctx.restore();

            for (const rs of renderShips) {
              if (rs.back === front) continue;
              if (rs.trailPts.length >= 2) {
                ctx.beginPath();
                ctx.moveTo(rs.trailPts[0][0], rs.trailPts[0][1]);
                for (let k = 1; k < rs.trailPts.length; k++) {
                  ctx.lineTo(rs.trailPts[k][0], rs.trailPts[k][1]);
                }
                ctx.strokeStyle = rs.isMine
                  ? 'rgba(34, 211, 238, 0.58)'
                  : 'rgba(148, 163, 184, 0.25)';
                ctx.lineWidth = rs.isMine ? 1.5 : 0.9;
                ctx.stroke();
              }
              drawGeometricShip(ctx, rs.x, rs.y, rs.angle, rs.size, rs.isMine, rs.scale);
            }

            const stationFront = stationCam.z >= 0;
            if (stationFront === front && !isOccludedBySphere(stationCam)) {
              drawOrbitalStation(ctx, stationScreenX, stationScreenY, stId);
            }
          };

          // Back-half orbit ring, back ships & station (behind globe)
          drawOrbitLayer(false);

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

          // Front-half orbit ring, front ships & station (in front of globe)
          drawOrbitLayer(true);
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
