import {
  AmbientLight,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  EdgesGeometry,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFSoftShadowMap,
  PlaneGeometry,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { BufferGeometry } from 'three';

/**
 * Room 204 as an architect's clay model: white board, fine ink edges, soft daylight. Each piece
 * of furniture is one line of the register, and its number floats above it. The model settles
 * once when it appears and then only moves when the pointer does. No loop runs in the
 * background: frames are drawn on demand.
 */

export interface MaquetteItem {
  readonly n: string;
  readonly label: string;
}

export interface Maquette {
  highlight(index: number | null): void;
  dispose(): void;
}

const CLAY = 0xf3f4f0;
const BOARD = 0xe7e9e3;
const INK = 0x141815;
const RUBRIC = 0xd63a1f;

interface Piece {
  readonly group: Group;
  readonly anchor: Vector3;
  readonly mats: MeshStandardMaterial[];
  readonly edges: LineBasicMaterial[];
  readonly dropFrom: number;
}

function part(group: Group, geo: BufferGeometry, x: number, y: number, z: number, mats: MeshStandardMaterial[], edges: LineBasicMaterial[], color = CLAY, ry = 0): Mesh {
  const mat = new MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 });
  const mesh = new Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const line = new LineBasicMaterial({ color: INK, transparent: true, opacity: 0.38 });
  const outline = new LineSegments(new EdgesGeometry(geo, 30), line);
  mesh.add(outline);
  group.add(mesh);
  mats.push(mat);
  edges.push(line);
  return mesh;
}

function box(w: number, h: number, d: number): BoxGeometry {
  return new BoxGeometry(w, h, d);
}

/** Builds the five register lines of Room 204, in register order. */
function furnish(scene: Scene): Piece[] {
  const pieces: Piece[] = [];
  const make = (build: (g: Group, m: MeshStandardMaterial[], e: LineBasicMaterial[]) => Vector3): void => {
    const g = new Group();
    const m: MeshStandardMaterial[] = [];
    const e: LineBasicMaterial[] = [];
    const anchor = build(g, m, e);
    scene.add(g);
    pieces.push({ group: g, anchor, mats: m, edges: e, dropFrom: 0.9 });
  };
  // 001 Bed, king size
  make((g, m, e) => {
    part(g, box(1.9, 0.34, 2.1), 0.35, 0.17, -0.92, m, e);
    part(g, box(1.84, 0.24, 2.02), 0.35, 0.46, -0.9, m, e, 0xfafaf8);
    part(g, box(2.02, 1.1, 0.1), 0.35, 0.55, -1.98, m, e);
    part(g, box(0.72, 0.13, 0.4), -0.1, 0.645, -1.68, m, e, 0xfcfcfa);
    part(g, box(0.72, 0.13, 0.4), 0.8, 0.645, -1.68, m, e, 0xfcfcfa);
    part(g, box(1.86, 0.06, 1.1), 0.35, 0.6, -0.42, m, e, 0xeeefeb);
    return new Vector3(0.55, 0.7, 0.05);
  });
  // 002 Armchair, upholstered
  make((g, m, e) => {
    const chair = new Group();
    part(chair, box(0.78, 0.36, 0.76), 0, 0.26, 0, m, e);
    part(chair, box(0.78, 0.66, 0.16), 0, 0.55, -0.3, m, e);
    part(chair, box(0.14, 0.5, 0.76), -0.39, 0.33, 0, m, e);
    part(chair, box(0.14, 0.5, 0.76), 0.39, 0.33, 0, m, e);
    for (const [x, z] of [[-0.32, -0.3], [0.32, -0.3], [-0.32, 0.3], [0.32, 0.3]] as const) part(chair, new CylinderGeometry(0.025, 0.025, 0.08, 8), x, 0.04, z, m, e, 0xd9dbd5);
    chair.position.set(-1.45, 0, 1.05);
    chair.rotation.y = 0.75;
    g.add(chair);
    return new Vector3(-1.45, 1.05, 1.05);
  });
  // 003 Television, Sony 43-inch, on the left wall
  make((g, m, e) => {
    part(g, box(0.05, 0.62, 1.04), -2.4, 1.42, -0.15, m, e, 0x2a2f2b);
    part(g, box(0.06, 0.16, 0.2), -2.43, 1.42, -0.15, m, e, 0xd9dbd5);
    part(g, box(0.4, 0.45, 1.2), -2.22, 0.225, -0.15, m, e);
    return new Vector3(-2.38, 1.86, -0.15);
  });
  // 004 Framed print, above the bed
  make((g, m, e) => {
    part(g, box(0.62, 0.82, 0.04), 0.35, 1.72, -2.02, m, e, 0xdedfd9);
    part(g, box(0.5, 0.7, 0.02), 0.35, 1.72, -1.995, m, e, 0xfbfbf9);
    return new Vector3(0.35, 2.25, -2.0);
  });
  // 005 Bedside lamps (2)
  make((g, m, e) => {
    for (const x of [-0.95, 1.65]) {
      part(g, box(0.46, 0.5, 0.42), x, 0.25, -1.78, m, e);
      part(g, new CylinderGeometry(0.05, 0.07, 0.26, 16), x, 0.63, -1.78, m, e);
      part(g, new CylinderGeometry(0.12, 0.17, 0.22, 20, 1, true), x, 0.86, -1.78, m, e, 0xfdfdfb);
    }
    return new Vector3(1.65, 1.02, -1.78);
  });
  return pieces;
}

export function mountMaquette(host: HTMLElement, labels: HTMLElement[], reduced: boolean): Maquette | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    return null;
  }
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.setClearColor(new Color(0x000000), 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.prepend(renderer.domElement);

  const scene = new Scene();
  scene.add(new HemisphereLight(0xffffff, 0xd4d8cf, 1.1));
  scene.add(new AmbientLight(0xffffff, 0.25));
  const sun = new DirectionalLight(0xffffff, 1.9);
  sun.position.set(3.5, 7, 5.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -5;
  sun.shadow.camera.right = 5;
  sun.shadow.camera.top = 5;
  sun.shadow.camera.bottom = -5;
  sun.shadow.radius = 5;
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  // The board: floor slab and the two walls of a cut-away room.
  const shell: MeshStandardMaterial[] = [];
  const shellEdges: LineBasicMaterial[] = [];
  const room = new Group();
  part(room, box(5.0, 0.16, 4.2), 0, -0.08, 0, shell, shellEdges, BOARD);
  part(room, box(5.0, 2.6, 0.12), 0, 1.3, -2.16, shell, shellEdges);
  part(room, box(0.12, 2.6, 4.2), -2.56, 1.3, 0, shell, shellEdges);
  part(room, box(1.1, 1.3, 0.13), 1.75, 1.45, -2.16, shell, shellEdges, 0xdfe6e4);
  scene.add(room);
  const ground = new Mesh(new PlaneGeometry(30, 30), new ShadowMaterial({ opacity: 0.12 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.161;
  ground.receiveShadow = true;
  scene.add(ground);

  const pieces = furnish(scene);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const target = new Vector3(-0.1, 0.95, 0);
  const base = { az: 0.72, el: 0.58 };
  let az = reduced ? base.az : base.az + 0.5;
  let pointer = 0;
  let size = { w: 1, h: 1 };
  let highlighted: number | null = null;
  let start = performance.now();
  let raf = 0;
  let disposed = false;

  const place = (): void => {
    const r = 14;
    camera.position.set(target.x + r * Math.cos(base.el) * Math.sin(az + pointer), target.y + r * Math.sin(base.el), target.z + r * Math.cos(base.el) * Math.cos(az + pointer));
    camera.lookAt(target);
    const span = 3.0;
    const aspect = size.w / size.h;
    camera.left = -span * aspect;
    camera.right = span * aspect;
    camera.top = span;
    camera.bottom = -span;
    camera.updateProjectionMatrix();
  };

  const positionLabels = (): void => {
    const v = new Vector3();
    pieces.forEach((p, i) => {
      const el = labels[i];
      if (!el) return;
      v.copy(p.anchor).project(camera);
      el.style.transform = `translate(${((v.x + 1) / 2) * size.w}px, ${((1 - v.y) / 2) * size.h}px)`;
    });
  };

  const draw = (): void => {
    place();
    renderer.render(scene, camera);
    positionLabels();
  };

  // One settle on arrival: the camera turns into place and the pieces are set down one by one.
  const intro = (now: number): void => {
    if (disposed) return;
    const t = Math.min(1, (now - start) / 1600);
    const ease = 1 - Math.pow(1 - t, 3);
    az = base.az + 0.5 * (1 - ease);
    pieces.forEach((p, i) => {
      const local = Math.min(1, Math.max(0, (now - start - 250 - i * 170) / 520));
      const e = 1 - Math.pow(1 - local, 3);
      p.group.position.y = p.dropFrom * (1 - e);
      p.mats.forEach((m) => {
        m.transparent = local < 1;
        m.opacity = e;
      });
      p.edges.forEach((l) => (l.opacity = 0.38 * e));
      const el = labels[i];
      if (el) el.style.opacity = String(e);
    });
    draw();
    if (t < 1 || now - start < 250 + pieces.length * 170 + 520) raf = requestAnimationFrame(intro);
  };

  const resize = (): void => {
    const r = host.getBoundingClientRect();
    size = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
    renderer.setSize(size.w, size.h, false);
    renderer.domElement.style.width = `${size.w}px`;
    renderer.domElement.style.height = `${size.h}px`;
    draw();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const onMove = (e: PointerEvent): void => {
    if (reduced) return;
    const r = host.getBoundingClientRect();
    pointer = ((e.clientX - r.left) / r.width - 0.5) * 0.22;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  };
  window.addEventListener('pointermove', onMove);

  if (reduced) {
    labels.forEach((el) => (el.style.opacity = '1'));
    draw();
  } else {
    pieces.forEach((p) => (p.group.position.y = p.dropFrom));
    start = performance.now();
    raf = requestAnimationFrame(intro);
  }

  return {
    highlight(index) {
      if (highlighted === index) return;
      highlighted = index;
      pieces.forEach((p, i) => {
        const on = index === i;
        p.edges.forEach((l) => {
          l.color.setHex(on ? RUBRIC : INK);
          l.opacity = on ? 0.95 : 0.38;
        });
      });
      labels.forEach((el, i) => el.toggleAttribute('data-on', index === i));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onMove);
      scene.traverse((o) => {
        if (o instanceof Mesh || o instanceof LineSegments) {
          o.geometry.dispose();
          const mat = o.material as { dispose?: () => void };
          mat.dispose?.();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
