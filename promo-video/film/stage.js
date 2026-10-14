// The 3D stage in plain Three.js: a laptop whose lid shuts, the home server's display, a
// phone, a teammate's display, the display for the webhook, a wall of production logs, the
// dashboard, the lines of light between them, and the camera. `draw(frame, screens)` sets everything for one frame
// and renders it.
import * as THREE from "three";
import { cameraAt, colors, costsPanel, easeIn, easeOut, FOV, HEIGHT, hookPanel, laptop, lidAngle, logWall, moodAt, morningPhone, phone, pop, progress, scene as scenes, serverPanel, serverTurn, teamPanel, WIDTH } from "./timeline.js";

const bodyMaterial = () => new THREE.MeshStandardMaterial({ color: "#464e56", metalness: 0.45, roughness: 0.42 });
const monospace = 'Menlo, "SF Mono", monospace';

/** A rounded rectangle centred on the origin. */
function roundedRect(width, height, radius) {
  const x = -width / 2;
  const y = -height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
}

/** A flat rounded screen whose texture fills it edge to edge. */
function screenGeometry(width, height, radius) {
  const geometry = new THREE.ShapeGeometry(roundedRect(width, height, radius), 12);
  const positions = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let index = 0; index < positions.count; index++) uv.setXY(index, positions.getX(index) / width + 0.5, positions.getY(index) / height + 0.5);
  uv.needsUpdate = true;
  return geometry;
}

/** A rounded slab, `depth` thick, with softened edges. */
function slabGeometry(width, height, radius, depth) {
  const bevel = Math.min(0.012, depth / 4);
  return new THREE.ExtrudeGeometry(roundedRect(width, height, radius), { depth: depth - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments: 16 });
}

/** A soft round glow in white, tinted by the material that uses it. */
export function glowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.33)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function mesh(geometry, material, position = [0, 0, 0], rotation = [0, 0, 0]) {
  const object = new THREE.Mesh(geometry, material);
  object.position.set(...position);
  object.rotation.set(...rotation);
  return object;
}

/** A screen surface. Unlit and outside tone mapping, so the app's colours arrive unchanged. */
function screenSurface(geometry) {
  const material = new THREE.MeshBasicMaterial({ color: "#0b0d0f", toneMapped: false });
  const surface = new THREE.Mesh(geometry, material);
  surface.userData.show = (texture, brightness = 1, opacity = 1) => {
    // A material compiled without a picture never samples one added later, so say when that changes.
    if (Boolean(material.map) !== Boolean(texture)) material.needsUpdate = true;
    material.map = texture;
    if (texture) material.color.setRGB(brightness, brightness, brightness);
    else material.color.set("#0b0d0f");
    material.transparent = opacity < 1;
    material.opacity = opacity;
  };
  return surface;
}

export function glowPlane(glow, width, height, position) {
  return mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: glow, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), position);
}

/** A canvas that is redrawn for each frame and shown on a screen: the two drawn screens of the film. */
function paintedScreen(paint) {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 800;
  const context = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 16;
  return { texture, paint(frame) { paint(context, frame); texture.needsUpdate = true; } };
}

/** The world without Joint Bob: an agent in a terminal, tied to this laptop. */
function paintTerminal(context, frame) {
  context.fillStyle = "#0c0f12";
  context.fillRect(0, 0, 1280, 800);
  context.fillStyle = "#171b20";
  context.fillRect(0, 0, 1280, 64);
  ["#ff5f57", "#febc2e", "#28c840"].forEach((color, index) => { context.fillStyle = color; context.beginPath(); context.arc(40 + index * 34, 32, 11, 0, Math.PI * 2); context.fill(); });
  context.fillStyle = "#7d858d";
  context.font = `26px ${monospace}`;
  context.textAlign = "center";
  context.fillText("agent · checkout-api", 640, 41);
  context.textAlign = "left";

  const command = 'agent "fix the double charge on payment retries"';
  const steps = [
    [22, "Reading src/payments/retry.ts"],
    [32, "Found it: a new key on every retry"],
    [42, "Writing a failing test"],
    [52, "Fixing retry.ts, running 48 tests"],
  ];
  context.font = `600 38px ${monospace}`;
  context.fillStyle = "#37cfab";
  context.fillText("$", 56, 150);
  context.fillStyle = "#e8eaec";
  context.fillText(command.slice(0, Math.max(0, Math.round(frame * 2.6))), 100, 150);
  steps.forEach(([at, text], index) => {
    if (frame < at) return;
    const y = 240 + index * 78;
    const done = frame > at + 9;
    context.fillStyle = done ? "#37cfab" : "#febc2e";
    context.fillText(done ? "✓" : "●", 56, y);
    context.fillStyle = "#c5cace";
    context.fillText(text, 110, y);
  });
  if (frame >= 58) {
    // The run that will never finish.
    const percent = Math.min(87, 40 + Math.round((frame - 58) * 1.9));
    const cells = 24;
    const filled = Math.round((percent / 100) * cells);
    context.fillStyle = "#1c2126";
    context.fillRect(56, 590, 880, 50);
    context.fillStyle = "#37cfab";
    context.fillRect(56, 590, (880 / cells) * filled, 50);
    context.fillStyle = "#e8eaec";
    context.font = `700 46px ${monospace}`;
    context.fillText(`${percent}%`, 968, 632);
    context.font = `30px ${monospace}`;
    context.fillStyle = "#7d858d";
    context.fillText("almost there…", 56, 700);
  }
}

/** Production at night: requests going by, then one error, over and over. */
function paintLogs(context, frame) {
  const local = frame - scenes.night;
  context.fillStyle = "#070a18";
  context.fillRect(0, 0, 1280, 800);
  context.fillStyle = "#10152c";
  context.fillRect(0, 0, 1280, 70);
  context.font = `600 28px ${monospace}`;
  context.textAlign = "left";
  context.fillStyle = "#8f9bd6";
  context.fillText("production · checkout-api · live logs", 36, 46);
  const breaks = 16;
  const newest = Math.floor((local + 60) / 2.5);
  const rows = 15;
  const routes = ["GET /cart 200 12ms", "POST /checkout 200 48ms", "GET /stock 200 9ms", "GET /cart/saved 200 14ms", "POST /payments 200 131ms", "GET /health 200 2ms"];
  context.font = `27px ${monospace}`;
  for (let row = 0; row < rows; row++) {
    const index = newest - (rows - 1 - row);
    const broken = index >= Math.floor((breaks + 60) / 2.5) && index % 5 !== 0;
    const second = String(Math.abs(index * 3) % 60).padStart(2, "0");
    const y = 122 + row * 45;
    if (broken) {
      context.fillStyle = "rgba(255,93,85,0.14)";
      context.fillRect(0, y - 31, 1280, 42);
      context.fillStyle = "#ff6f67";
      context.fillText(`03:00:${second} ERROR TypeError: cannot read 'currency' of undefined  formatPrice`, 36, y);
    } else {
      context.fillStyle = "#5d688f";
      context.fillText(`${local < breaks ? "02:59" : "03:00"}:${second} INFO  ${routes[Math.abs(index) % routes.length]}`, 36, y);
    }
  }
}

/** A laptop at the origin: the body, and a lid that turns on its back edge. */
export function buildLaptopParts() {
  const { width, depth, height, lidThickness, screenWidth, screenHeight } = laptop;
  const group = new THREE.Group();
  group.add(mesh(slabGeometry(width, depth, 0.14, height), bodyMaterial(), [0, 0, 0], [-Math.PI / 2, 0, 0]));
  group.add(mesh(new THREE.PlaneGeometry(2.92, 1.12), new THREE.MeshStandardMaterial({ color: "#15181b", roughness: 0.9 }), [0, height + 0.001, -0.45], [-Math.PI / 2, 0, 0]));
  const keyMaterial = new THREE.MeshStandardMaterial({ color: "#2b3036", roughness: 0.6 });
  const keyGeometry = new THREE.BoxGeometry(0.165, 0.014, 0.165);
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 14; column++) {
      // The bottom row leaves room for the space bar.
      if (row === 4 && column > 3 && column < 10) continue;
      group.add(mesh(keyGeometry, keyMaterial, [-1.3 + column * 0.2, height + 0.008, -0.86 + row * 0.2]));
    }
  }
  group.add(mesh(new THREE.BoxGeometry(1.16, 0.014, 0.165), keyMaterial, [0, height + 0.008, -0.06]));
  group.add(mesh(new THREE.PlaneGeometry(1.3, 0.74), new THREE.MeshStandardMaterial({ color: "#3c4249", roughness: 0.35, metalness: 0.3 }), [0, height + 0.001, 0.62], [-Math.PI / 2, 0, 0]));

  // The lid turns on the back edge. Shut, its screen faces down onto the keys.
  const lid = new THREE.Group();
  lid.position.set(0, height, -depth / 2);
  const lidGeometry = slabGeometry(width, depth, 0.14, lidThickness);
  lidGeometry.translate(0, depth / 2, 0);
  lid.add(mesh(lidGeometry, bodyMaterial(), [0, lidThickness, 0], [Math.PI / 2, 0, 0]));
  lid.add(mesh(new THREE.PlaneGeometry(width - 0.05, depth - 0.05), new THREE.MeshBasicMaterial({ color: "#050607" }), [0, -0.002, depth / 2], [Math.PI / 2, 0, 0]));
  const display = screenSurface(screenGeometry(screenWidth, screenHeight, 0.035));
  display.position.set(0, -0.004, depth / 2 + 0.01);
  display.rotation.set(Math.PI / 2, 0, 0);
  lid.add(display);
  const badge = mesh(new THREE.CircleGeometry(0.1, 40), new THREE.MeshBasicMaterial({ color: colors.accent, toneMapped: false }), [0, lidThickness + 0.016, depth / 2], [-Math.PI / 2, 0, 0]);
  lid.add(badge);
  group.add(lid);

  // The screen lights the keys while it is open.
  const light = new THREE.PointLight("#8fe9d6", 9, 5, 2);
  light.position.set(0, 0.9, 0.1);
  group.add(light);

  return { group, lid, display, light, badge };
}

function buildLaptop(terminal) {
  const { group, lid, display, light, badge } = buildLaptopParts();
  return { group, draw(frame, recording) {
    const angle = lidAngle(frame);
    const open = Math.min(1, angle / laptop.openAngle);
    lid.rotation.x = -angle;
    // Before the rewind the laptop runs a bare terminal; after it, Joint Bob.
    const painted = frame < scenes.rewind;
    if (painted && open > 0) terminal.paint(frame);
    display.userData.show(painted ? terminal.texture : recording, 0.25 + 0.75 * open);
    light.intensity = 11 * open;
    // The light on the lid goes red and dark with the agent.
    const dead = frame >= scenes.dead && frame < scenes.rewind;
    badge.material.color.set(dead ? (Math.floor(frame / 9) % 2 ? "#3a1513" : colors.danger) : colors.accent);
  } };
}

export function buildDisplay(width, height, glow) {
  const group = new THREE.Group();
  const halo = glowPlane(glow, width * 2.1, height * 2.3, [0, 0, -1.2]);
  const frameMaterial = bodyMaterial();
  const display = screenSurface(screenGeometry(width, height, 0.06));
  display.position.set(0, 0, 0.004);
  group.add(halo, mesh(slabGeometry(width + 0.14, height + 0.14, 0.11, 0.07), frameMaterial, [0, 0, -0.075]), display);
  return { group, show(texture, brightness, opacity, tint) {
    halo.material.opacity = 0.36 * opacity;
    halo.material.color.copy(tint);
    frameMaterial.transparent = opacity < 1;
    frameMaterial.opacity = opacity;
    display.userData.show(texture, brightness, opacity);
  } };
}

export function buildPhoneParts(glow) {
  const { screenWidth, screenHeight } = phone;
  const group = new THREE.Group();
  const halo = glowPlane(glow, screenWidth * 3.4, screenHeight * 1.7, [0, 0, -0.9]);
  const display = screenSurface(screenGeometry(screenWidth, screenHeight, 0.12));
  display.position.set(0, 0, 0.006);
  group.add(halo, mesh(slabGeometry(screenWidth + 0.1, screenHeight + 0.1, 0.16, 0.1), new THREE.MeshStandardMaterial({ color: "#262b30", metalness: 0.5, roughness: 0.35 }), [0, 0, -0.1]), display);
  return { group, halo, display };
}

function buildPhone(glow) {
  const { group, halo, display } = buildPhoneParts(glow);
  return { group, draw(frame, texture, tint) {
    // One phone, two scenes: beside the server in the evening, on its own the next morning.
    const morning = frame >= scenes.morning - 12;
    const place = morning ? morningPhone : phone;
    const arrive = morning ? pop(progress(frame, scenes.morning - 2, scenes.morning + 16)) : easeOut(progress(frame, scenes.phone - 2, scenes.phone + 20)) * (1 - easeIn(progress(frame, scenes.team - 4, scenes.team + 14)));
    group.visible = frame >= scenes.phone - 6 && (morning || frame < scenes.team + 16);
    group.position.set(place.center.x, place.center.y - 3.4 * (1 - Math.min(1, arrive)) + Math.sin(frame / 33) * 0.02, place.center.z);
    group.rotation.set(-0.5 * (1 - Math.min(1, arrive)), place.turn + 1.5 * (1 - Math.min(1, arrive)) + Math.sin(frame / 40) * 0.04, 0);
    group.scale.setScalar(morning ? 0.9 + 0.1 * arrive : 1);
    halo.material.opacity = 0.4 * Math.min(1, arrive);
    halo.material.color.copy(tint);
    display.userData.show(texture);
  } };
}

/** A line of light from one machine to the next, with a pulse that travels along it. */
export function buildLink(from, via, to, drawFrom, drawTo, gone = Infinity) {
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(...from), new THREE.Vector3(...via), new THREE.Vector3(...to));
  const segments = 80;
  const radial = 6;
  const geometry = new THREE.TubeGeometry(curve, segments, 0.013, radial, false);
  const group = new THREE.Group();
  const pulse = mesh(new THREE.SphereGeometry(0.04, 16, 16), new THREE.MeshBasicMaterial({ color: "#d8fff5", toneMapped: false }));
  group.add(mesh(geometry, new THREE.MeshBasicMaterial({ color: colors.accent, transparent: true, opacity: 0.6, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false })), pulse);
  return { group, draw(frame) {
    const drawn = easeOut(progress(frame, drawFrom, drawTo));
    group.visible = drawn > 0 && frame < gone;
    geometry.setDrawRange(0, Math.floor(segments * drawn) * radial * 6);
    pulse.position.copy(curve.getPoint(Math.min(((frame - drawFrom) % 36) / 36, drawn)));
  } };
}

/** Slow motes of light through the whole room. Their places come from a fixed sequence, so every render is the same. */
export function buildMotes() {
  const count = 320;
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const home = Array.from({ length: count }, () => [-5 + random() * 36, 0.2 + random() * 6.5, -9 + random() * 13, random() * Math.PI * 2, 0.4 + random()]);
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ size: 0.055, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, draw(frame, tint) {
    home.forEach(([x, y, z, phase, speed], index) => {
      positions[index * 3] = x + Math.sin(frame / 60 * speed + phase) * 0.35;
      positions[index * 3 + 1] = y + Math.sin(frame / 45 * speed + phase * 2) * 0.3 + ((frame * 0.004 * speed) % 1);
      positions[index * 3 + 2] = z;
    });
    geometry.attributes.position.needsUpdate = true;
    material.color.copy(tint);
  } };
}

/** The room every film is set in: renderer, lights, floor, and a wash of colour far behind the devices. */
export function buildRoom(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const world = new THREE.Scene();
  world.background = new THREE.Color(colors.background);
  world.fog = new THREE.Fog(colors.background, 14, 48);
  const camera = new THREE.PerspectiveCamera(FOV, WIDTH / HEIGHT, 0.1, 200);

  world.add(new THREE.AmbientLight("#ffffff", 1.5));
  const key = new THREE.DirectionalLight("#ffffff", 3.6);
  key.position.set(3, 7, 8);
  const rim = new THREE.DirectionalLight("#7fdcc6", 1.8);
  rim.position.set(-6, 4, -5);
  world.add(key, rim);

  const glow = glowTexture();
  // A wash of colour far behind the devices, for depth. It follows the camera along the room.
  const wash = glowPlane(glow, 52, 24, [5, 3.4, -9]);
  wash.material.fog = false;
  world.add(wash);

  const floor = new THREE.MeshStandardMaterial({ color: "#0b1013", roughness: 0.95 });
  world.add(mesh(new THREE.PlaneGeometry(400, 400), floor, [0, -0.002, 0], [-Math.PI / 2, 0, 0]));
  const grid = new THREE.GridHelper(160, 160, "#3a7a6d", "#22373a");
  grid.material.transparent = true;
  grid.material.opacity = 0.8;
  grid.position.y = 0.001;
  world.add(grid);
  return { renderer, world, camera, glow, wash };
}

export function createStage(canvas) {
  const { renderer, world, camera, glow, wash } = buildRoom(canvas);

  const terminal = paintedScreen(paintTerminal);
  const logs = paintedScreen(paintLogs);
  const computer = buildLaptop(terminal);
  const server = buildDisplay(serverPanel.width, serverPanel.height, glow);
  server.group.rotation.y = serverPanel.turn;
  const handset = buildPhone(glow);
  const team = buildDisplay(teamPanel.width, teamPanel.height, glow);
  team.group.rotation.y = teamPanel.turn;
  const hook = buildDisplay(hookPanel.width, hookPanel.height, glow);
  const costs = buildDisplay(costsPanel.width, costsPanel.height, glow);
  const wall = buildDisplay(logWall.width, logWall.height, glow);
  const motes = buildMotes();

  // The work travels: laptop to server, server to phone, server to teammate, and an alert into the server's webhook.
  const links = [
    buildLink([0.6, 0.2, -0.7], [1.2, 2.4, -1.4], [serverPanel.center.x - 2.1, serverPanel.center.y - 1.2, serverPanel.center.z + 0.2], scenes.lidTwo + 21, scenes.lidTwo + 47),
    buildLink([serverPanel.center.x + 2.2, serverPanel.center.y - 0.9, serverPanel.center.z + 0.1], [5.6, 0.0, 0.4], [phone.center.x - 0.1, phone.center.y - 1.12, phone.center.z - 0.2], scenes.phone - 2, scenes.phone + 20, scenes.team + 4),
    buildLink([serverPanel.center.x + 1.6, serverPanel.center.y + 1.55, serverPanel.center.z + 0.1], [6.5, 4.6, -1.2], [teamPanel.center.x - 1.6, teamPanel.center.y + 1.55, teamPanel.center.z + 0.1], scenes.team + 6, scenes.team + 30),
    buildLink([serverPanel.center.x + 2.0, serverPanel.center.y + 1.55, serverPanel.center.z], [9.5, 6.4, -1.6], [hookPanel.center.x - 2.7, hookPanel.center.y + 1.3, 0], scenes.hook - 8, scenes.hook + 14),
  ];
  world.add(computer.group, server.group, handset.group, team.group, hook.group, costs.group, wall.group, motes.points, ...links.map((link) => link.group));

  return {
    renderer,
    /** `screens` holds the recording frame each screen shows at this frame, or null while it is off. */
    draw(frame, screens) {
      const view = cameraAt(frame);
      camera.position.copy(view.position);
      camera.lookAt(view.target);

      const mood = moodAt(frame);
      world.background.copy(mood.background);
      world.fog.color.copy(mood.background);
      wash.material.color.copy(mood.glow);
      wash.material.opacity = 0.3;
      wash.position.x = view.target.x + 1;
      motes.draw(frame, mood.glow);

      computer.draw(frame, screens.laptop);

      const arrive = pop(progress(frame, scenes.lidTwo + 21, scenes.lidTwo + 47));
      // The server steps back while the phone has the floor, and returns for the last wide shot.
      const dim = progress(frame, scenes.phone - 6, scenes.phone + 14) * (1 - progress(frame, scenes.end - 10, scenes.end + 10));
      server.group.visible = frame >= scenes.lidTwo + 15;
      server.group.position.set(serverPanel.center.x + 1.6 * (1 - Math.min(1, arrive)), serverPanel.center.y + Math.sin(frame / 45) * 0.03, serverPanel.center.z - 5 * (1 - Math.min(1, arrive)));
      server.group.scale.setScalar(0.86 + 0.14 * arrive);
      server.group.rotation.y = serverTurn(frame);
      // It also gives way to the phone, and comes back to full when the teammate arrives.
      server.show(screens.server, 1 - 0.5 * dim * (1 - progress(frame, scenes.team - 4, scenes.team + 10)), Math.min(1, arrive), mood.glow);

      const joins = pop(progress(frame, scenes.team + 2, scenes.team + 22));
      team.group.visible = frame >= scenes.team;
      team.group.position.set(teamPanel.center.x + 2.2 * (1 - Math.min(1, joins)), teamPanel.center.y + Math.sin(frame / 43 + 2) * 0.03, teamPanel.center.z - 4 * (1 - Math.min(1, joins)));
      team.group.scale.setScalar(0.86 + 0.14 * joins);
      team.show(screens.teammate, 1, Math.min(1, joins), mood.glow);

      handset.draw(frame, frame >= scenes.morning - 12 ? screens.morning : screens.phone, mood.glow);

      hook.group.visible = frame >= scenes.hook - 10;
      hook.group.position.set(hookPanel.center.x, hookPanel.center.y + Math.sin(frame / 50 + 1) * 0.02, hookPanel.center.z);
      hook.show(screens.webhook, 1, 1, mood.glow);

      costs.group.visible = frame >= scenes.costs - 8;
      costs.group.position.set(costsPanel.center.x, costsPanel.center.y + Math.sin(frame / 47 + 3) * 0.02, costsPanel.center.z);
      costs.show(screens.costs, 1, 1, mood.glow);

      const night = frame >= scenes.night - 2 && frame < scenes.report;
      wall.group.visible = night;
      if (night) {
        logs.paint(frame);
        wall.group.position.set(logWall.center.x, logWall.center.y + Math.sin(frame / 40) * 0.03, logWall.center.z);
        wall.show(logs.texture, 1, 1, new THREE.Color(colors.danger).lerp(mood.glow, 1 - progress(frame, scenes.night + 14, scenes.night + 26)));
      }

      for (const link of links) link.draw(frame);
      renderer.render(world, camera);
    },
  };
}
