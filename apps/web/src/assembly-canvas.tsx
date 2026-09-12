import { useEffect, useRef, useState } from "react";
import { ACESFilmicToneMapping, SRGBColorSpace, AmbientLight, Box3, Box3Helper, BufferGeometry, Color, DirectionalLight, Euler, Float32BufferAttribute, Mesh, MeshStandardMaterial, PerspectiveCamera, Raycaster, Scene, Vector2, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { AssemblyGeometry, AssemblyPart } from "@benchledger/api-contract";
export interface AssemblyCanvasProps { geometry: AssemblyGeometry[]; parts: AssemblyPart[]; hidden: Set<string>; selected: string | undefined; explosion: number; view: "front" | "rear" | "iso"; fit: number; onSelect(id: string): void }
export default function AssemblyCanvas(props: AssemblyCanvasProps) {
  const host = useRef<HTMLDivElement>(null), latest = useRef(props), update = useRef<() => void>(() => {}), fitView = useRef<() => void>(() => {});
  latest.current = props;
  const [error, setError] = useState<string>(), [dimensions, setDimensions] = useState("");
  useEffect(() => {
    const container = host.current; if (!container) return;
    let renderer: WebGLRenderer | undefined, controls: OrbitControls | undefined, observer: ResizeObserver | undefined, themeObserver: MutationObserver | undefined;
    const objects = new Map<string, { mesh: Mesh<BufferGeometry, MeshStandardMaterial>; origin: Vector3 }>();
    const geometries: BufferGeometry[] = [], materials: MeshStandardMaterial[] = [];
    const scene = new Scene(), selection = new Box3Helper(new Box3(), 0x35664e); selection.visible = false; scene.add(selection);
    let disposed = false;
    const dispose = () => { if (disposed) return; disposed = true; observer?.disconnect(); themeObserver?.disconnect(); controls?.dispose(); geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); selection.geometry.dispose(); (selection.material as MeshStandardMaterial).dispose(); renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove(); };
    try {
      renderer = new WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor(new Color(getComputedStyle(container).getPropertyValue("--assembly-stage").trim() || "#eae9e2")); renderer.outputColorSpace = SRGBColorSpace; renderer.toneMapping = ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
      renderer.domElement.setAttribute("aria-label", "Assembly model. Select parts using the parts list or click the model."); renderer.domElement.setAttribute("role", "img"); container.append(renderer.domElement);
      const camera = new PerspectiveCamera(35, 1, 0.1, 1e8); camera.up.set(0, 0, 1); camera.position.set(400, -650, 350);
      controls = new OrbitControls(camera, renderer.domElement); controls.maxDistance = 5e7; controls.minDistance = 0.1;
      scene.add(new AmbientLight(0xffffff, 2.5));
      const key = new DirectionalLight(0xfff5e5, 3.1); key.position.set(-300, -400, 600); scene.add(key);
      const fill = new DirectionalLight(0xe3ecff, 1.8); fill.position.set(300, 250, 300); scene.add(fill);
      for (const part of props.parts) {
        const raw = props.geometry.find(g => g.artifactId === part.artifactId && g.nodeId === part.nodeId);
        if (!raw) throw new Error(`The source geometry for ${part.name} is unavailable. Reinspect its source file.`);
        const geometry = new BufferGeometry(); geometries.push(geometry); geometry.setAttribute("position", new Float32BufferAttribute(raw.positions, 3)); geometry.setIndex(raw.indices); geometry.computeVertexNormals(); geometry.computeBoundingBox();
        const origin = geometry.boundingBox!.getCenter(new Vector3()); geometry.translate(-origin.x, -origin.y, -origin.z);
        const material = new MeshStandardMaterial({ color: part.color, roughness: 0.72 }); materials.push(material);
        const mesh = new Mesh(geometry, material); mesh.userData.partId = part.id; objects.set(part.id, { mesh, origin }); scene.add(mesh);
      }
      const render = () => { if (!disposed) renderer!.render(scene, camera); };
      controls.addEventListener("change", render);
      themeObserver = new MutationObserver(() => { renderer!.setClearColor(new Color(getComputedStyle(container).getPropertyValue("--assembly-stage").trim() || "#eae9e2")); render(); });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      const bounds = () => { const box = new Box3(); for (const { mesh } of objects.values()) if (mesh.visible) box.expandByObject(mesh); return box; };
      fitView.current = () => {
        const box = bounds(); if (box.isEmpty()) return;
        const centre = box.getCenter(new Vector3()), radius = Math.max(box.getSize(new Vector3()).length() / 2, 1);
        const direction = new Vector3(...(latest.current.view === "rear" ? [1, 2, 0.8] as const : latest.current.view === "front" ? [0, -2, 0.25] as const : [1, -1.8, 1] as const)).normalize();
        const fov = Math.min(camera.fov * Math.PI / 180, 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect));
        const distance = radius / Math.sin(fov / 2) * 1.15;
        camera.position.copy(centre).addScaledVector(direction, distance); camera.near = Math.max(0.01, distance / 10000); camera.far = Math.max(1000, distance * 10); camera.updateProjectionMatrix(); controls!.target.copy(centre); controls!.update(); render();
      };
      update.current = () => {
        selection.visible = false;
        const assembled = new Box3();
        for (const part of latest.current.parts) {
          const entry = objects.get(part.id); if (!entry) continue;
          const { mesh, origin } = entry;
          mesh.position.copy(origin).add(new Vector3(...part.position)); mesh.rotation.copy(new Euler(...part.rotation.map(v => v * Math.PI / 180) as [number, number, number])); mesh.updateMatrixWorld(true); assembled.expandByObject(mesh);
          mesh.position.addScaledVector(new Vector3(...part.explode), latest.current.explosion / 100); mesh.visible = !latest.current.hidden.has(part.id); mesh.material.color.set(part.color); mesh.material.emissive.set(part.id === latest.current.selected ? 0x183024 : 0);
          mesh.updateMatrixWorld(true);
          if (mesh.visible && part.id === latest.current.selected) { selection.box.setFromObject(mesh); selection.visible = true; }
        }
        const size = assembled.getSize(new Vector3()); setDimensions(`${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`); render();
      };
      const resize = () => { renderer!.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight)); camera.aspect = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight); camera.updateProjectionMatrix(); fitView.current(); };
      observer = new ResizeObserver(resize); observer.observe(container);
      let start: { x: number; y: number } | undefined;
      renderer.domElement.addEventListener("pointerdown", e => { start = e.button === 0 ? { x: e.clientX, y: e.clientY } : undefined; });
      renderer.domElement.addEventListener("pointerup", e => {
        if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
        const rect = renderer!.domElement.getBoundingClientRect(), ray = new Raycaster(); ray.setFromCamera(new Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
        const hit = ray.intersectObjects([...objects.values()].map(v => v.mesh).filter(m => m.visible))[0]; if (hit) latest.current.onSelect(hit.object.userData.partId as string);
      });
      renderer.domElement.addEventListener("webglcontextlost", e => { e.preventDefault(); if (!disposed) setError("The graphics context was lost. Reopen Assembly to restore the view."); });
      setError(undefined); update.current(); resize();
    } catch (cause) { dispose(); setError(cause instanceof Error ? cause.message : "3D viewing is unavailable in this browser."); }
    return () => { update.current = () => {}; fitView.current = () => {}; dispose(); };
  }, [props.geometry, props.parts.map(p => `${p.id}:${p.artifactId}:${p.nodeId}`).join("|")]);
  useEffect(() => update.current(), [props.parts, props.hidden, props.selected, props.explosion]);
  useEffect(() => fitView.current(), [props.fit, props.view]);
  return <><div className="assembly-dimensions">{dimensions}<small>assembled model bounds</small></div>{error && <p role="alert" className="assembly-render-error">{error} The parts list and assembly notes remain available.</p>}<div className="assembly-canvas" ref={host} /></>;
}
