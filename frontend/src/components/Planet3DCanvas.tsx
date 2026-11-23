import React, { useEffect, useMemo, useRef, useState } from 'react';

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
  atmoColor: string;
  mode: 'volcanic' | 'terrestrial' | 'icy';
}

const PROFILES: Record<string, PlanetProfile> = {
  P1: {
    seed: 10131,
    seaOffset: -0.3,
    tempBias: 0.45,
    moistBias: -0.45,
    tiltDeg: 10,
    atmoColor: 'rgba(234, 120, 62, 0.22)',
    mode: 'volcanic',
  },
  P2: {
    seed: 20263,
    seaOffset: 0.04,
    tempBias: 0.03,
    moistBias: 0.14,
    tiltDeg: 22,
    atmoColor: 'rgba(56, 189, 248, 0.25)',
    mode: 'terrestrial',
  },
  P3: {
    seed: 30397,
    seaOffset: -0.02,
    tempBias: -0.45,
    moistBias: -0.1,
    tiltDeg: 17,
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

function rotatePoint(p: Vec3, yaw: number, pitch: number, tiltRad: number): Vec3 {
  // 1) Spin around local Y (planet rotation + user yaw)
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = p.x * cy + p.z * sy;
  const y1 = p.y;
  const z1 = -p.x * sy + p.z * cy;

  // 2) Axial tilt around Z
  const ct = Math.cos(tiltRad);
  const st = Math.sin(tiltRad);
  const x2 = x1 * ct - y1 * st;
  const y2 = x1 * st + y1 * ct;
  const z2 = z1;

  // 3) Camera pitch around X
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return {
    x: x2,
    y: y2 * cp - z2 * sp,
    z: y2 * sp + z2 * cp,
  };
}

export const Planet3DCanvas: React.FC<{ planetId: string }> = ({ planetId }) => {
  const profile = PROFILES[planetId] ?? PROFILES.P2;
  const facets = useMemo(() => buildGoldbergFacets(4, profile), [profile]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const yawRef = useRef<number>(0.6);
  const pitchRef = useRef<number>(0.28);
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

          if (!draggingRef.current.active) {
            yawRef.current += 0.0045;
          }

          const cx = w / 2;
          const cy = h / 2 + 2;
          const radius = Math.min(w, h) * 0.34;
          const tiltRad = (profile.tiltDeg * Math.PI) / 180;
          const yaw = yawRef.current;
          const pitch = pitchRef.current;
          const sunDir = norm3({ x: 0.72, y: 0.42, z: 0.55 });

          // Subtle polar axis spine (like Prosperous Universe globe)
          const northPole = rotatePoint({ x: 0, y: 1.24, z: 0 }, yaw, pitch, tiltRad);
          const southPole = rotatePoint({ x: 0, y: -1.24, z: 0 }, yaw, pitch, tiltRad);
          ctx.strokeStyle = 'rgba(203, 213, 225, 0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx + southPole.x * radius, cy - southPole.y * radius);
          ctx.lineTo(cx + northPole.x * radius, cy - northPole.y * radius);
          ctx.stroke();

          // Atmosphere glow behind globe
          const grad = ctx.createRadialGradient(
            cx - radius * 0.25,
            cy - radius * 0.25,
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

          // Back-half orbital station rings
          const drawRingPass = (frontHalf: boolean) => {
            const rings = [
              { r: 1.22, tiltX: 0.36, rotZ: 0.18, alpha: 0.45 },
              { r: 1.32, tiltX: -0.28, rotZ: -0.22, alpha: 0.3 },
            ];
            for (const ring of rings) {
              ctx.strokeStyle = `rgba(203, 213, 225, ${frontHalf ? ring.alpha : ring.alpha * 0.3})`;
              ctx.lineWidth = 1;
              ctx.beginPath();
              let started = false;
              const segs = 72;
              for (let i = 0; i <= segs; i++) {
                const a = (i / segs) * Math.PI * 2;
                const rx = Math.cos(a) * ring.r;
                const rz = Math.sin(a) * ring.r;
                const pTilt: Vec3 = {
                  x: rx * Math.cos(ring.rotZ) - rz * Math.sin(ring.tiltX) * Math.sin(ring.rotZ),
                  y: rz * Math.sin(ring.tiltX) * Math.cos(ring.rotZ) + rx * Math.sin(ring.rotZ) * 0.4,
                  z: rz * Math.cos(ring.tiltX),
                };
                const rp = rotatePoint(pTilt, 0, pitch * 0.6, 0);
                const isFront = rp.z >= 0;
                if (isFront === frontHalf) {
                  const sx = cx + rp.x * radius;
                  const sy = cy - rp.y * radius;
                  if (!started) {
                    ctx.moveTo(sx, sy);
                    started = true;
                  } else {
                    ctx.lineTo(sx, sy);
                  }
                } else {
                  started = false;
                }
              }
              ctx.stroke();
            }
          };

          drawRingPass(false);

          // Project visible Goldberg facets & sort back-to-front
          const visible: Array<{
            facet: GoldbergFacet;
            depth: number;
            light: number;
            pts: Array<[number, number]>;
          }> = [];

          for (const f of facets) {
            const rc = rotatePoint(f.center, yaw, pitch, tiltRad);
            const rn = rotatePoint(f.normal, yaw, pitch, tiltRad);
            if (rn.z <= -0.05) continue;
            const light = Math.max(0.24, 0.28 + Math.max(0, dot3(rn, sunDir)) * 0.92);
            const pts: Array<[number, number]> = f.corners.map((c) => {
              const p = rotatePoint(c, yaw, pitch, tiltRad);
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

          drawRingPass(true);

          // Orbiting local station badge on front ring
          const stAngle = yaw * 1.4 + 0.8;
          const stP = rotatePoint(
            { x: Math.cos(stAngle) * 1.22, y: Math.sin(stAngle) * 0.42, z: Math.sin(stAngle) * 1.22 },
            0,
            pitch * 0.6,
            0,
          );
          if (stP.z >= -0.2) {
            const sx = cx + stP.x * radius;
            const sy = cy - stP.y * radius;
            ctx.fillStyle = '#202732';
            ctx.strokeStyle = '#e2e8f0';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(sx, sy, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(sx - 3, sy);
            ctx.lineTo(sx + 3, sy);
            ctx.moveTo(sx, sy - 3);
            ctx.lineTo(sx, sy + 3);
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
      <div className="absolute top-1.5 right-2.5 z-10 pointer-events-none text-[10px] text-slate-400">
        提示：左/右键拖动以旋转
      </div>
      {selectedInfo && (
        <div className="absolute bottom-2 left-2.5 z-10 pointer-events-none px-2 py-0.5 rounded bg-[#202732]/90 border border-sky-500/30 text-[10px] text-sky-200 mono">
          {selectedInfo}
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
          yawRef.current += dx * 0.012;
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
