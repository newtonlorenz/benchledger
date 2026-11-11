import { Alert } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { useEffect, useRef, useState } from "react";
import { AmbientLight, Color, DirectionalLight, GridHelper, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import type { BufferGeometry, Material } from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** Size of the model as recorded in the file, before any viewer transform. */
export interface ModelSize { x: number; y: number; z: number }

/**
 * Parse an STL into a Z-up scene geometry. Units stay as recorded (STL has no unit;
 * slicers and CAD tools treat it as millimetres). The part is centred in X/Y and
 * rests on the Z=0 build plane, as it would on a print bed.
 */
export function readStlGeometry(bytes: ArrayBuffer) {
  // Validate binary length/count before the loader trusts the header to allocate.
  if (bytes.byteLength >= 84) {
    const triangles = new DataView(bytes).getUint32(80, true);
    const binary = 84 + triangles * 50 === bytes.byteLength;
    const header = new TextDecoder().decode(bytes.slice(0, 9));
    if (!binary && !/^.{0,4}solid/su.test(header)) throw new Error("This STL is truncated or invalid.");
    if (binary && triangles > 250_000) throw new Error("This model is too complex to preview. Download it to view it locally.");
  } else throw new Error("This STL is empty or invalid.");
  const geometry = new STLLoader().parse(bytes);
  const positions = geometry.getAttribute("position");
  if (!positions || positions.count < 3 || positions.count > 750_000 || !positions.array.every(Number.isFinite)) {
    geometry.dispose();
    throw new Error("This STL is empty, invalid, or too complex to preview.");
  }
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const size = box.getSize(new Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(extent) || extent <= 0) { geometry.dispose(); throw new Error("This STL has no viewable geometry."); }
  const centre = box.getCenter(new Vector3());
  geometry.translate(-centre.x, -centre.y, -box.min.z);
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();
  geometry.userData.size = { x: size.x, y: size.y, z: size.z } satisfies ModelSize;
  return geometry;
}

/** Format model bounds for the viewer readout, e.g. "40.0 × 25.5 × 12.0 mm". */
export function formatModelSize(size: ModelSize): string {
  const value = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(1));
  return `${value(size.x)} × ${value(size.y)} × ${value(size.z)} mm`;
}

/** Pick a 1/2/5 × 10ⁿ grid step that gives roughly 4–10 cells across the model. */
export function gridStep(extent: number): number {
  if (!Number.isFinite(extent) || extent <= 0) return 10;
  const raw = extent / 6, power = 10 ** Math.floor(Math.log10(raw)), scaled = raw / power;
  return (scaled < 1.5 ? 1 : scaled < 3.5 ? 2 : scaled < 7.5 ? 5 : 10) * power;
}

/** Read the shared viewer tokens so both 3D viewers follow the active theme. */
export function viewerColours(element: Element) {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return { stage: read("--viewer-stage", "#e4e8ed"), grid: read("--viewer-grid", "#c3cad3"), gridMajor: read("--viewer-grid-major", "#9aa5b3"), model: read("--viewer-model", "#8d96a1"), accent: read("--accent", "#aa3e0d") };
}

/** A build-plane grid in the XY plane (Z up), centred on the origin, at height z. */
export function buildPlaneGrid(extent: number, element: Element, z = 0): GridHelper {
  const step = gridStep(extent), cells = Math.max(4, Math.ceil((extent * 1.6) / step / 2) * 2);
  const colours = viewerColours(element);
  const grid = new GridHelper(cells * step, cells, new Color(colours.gridMajor), new Color(colours.grid));
  grid.rotation.x = Math.PI / 2; grid.position.z = z; grid.userData.step = step;
  return grid;
}

export function disposeGrid(grid: GridHelper | undefined) {
  if (!grid) return;
  grid.geometry.dispose(); (Array.isArray(grid.material) ? grid.material : [grid.material]).forEach((material: Material) => material.dispose());
}

export default function StlPreview({ bytes }: { bytes: ArrayBuffer }) {
  const host = useRef<HTMLDivElement>(null);
  const reset = useRef<() => void>(() => undefined);
  const [error, setError] = useState<string>();
  const [size, setSize] = useState<ModelSize>();
  const [step, setStep] = useState<number>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    setError(undefined);
    let renderer: WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let observer: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let geometry: BufferGeometry | undefined;
    let material: MeshStandardMaterial | undefined;
    let grid: ReturnType<typeof buildPlaneGrid> | undefined;
    let disposed = false;
    const dispose = () => { if (disposed) return; disposed = true; observer?.disconnect(); themeObserver?.disconnect(); controls?.dispose(); geometry?.dispose(); material?.dispose(); disposeGrid(grid); renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove(); };
    try {
      geometry = readStlGeometry(bytes);
      const modelSize = geometry.userData.size as ModelSize;
      const extent = Math.max(modelSize.x, modelSize.y, modelSize.z);
      setSize(modelSize);
      renderer = new WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.domElement.setAttribute("aria-label", `STL model preview, ${formatModelSize(modelSize)}`);
      renderer.domElement.setAttribute("role", "img");
      renderer.domElement.addEventListener("webglcontextlost", event => {
        event.preventDefault();
        if (!disposed) { reset.current = () => undefined; dispose(); setError("The graphics connection was lost. Retry to restore the preview."); }
      });
      container.append(renderer.domElement);
      const scene = new Scene();
      const colours = viewerColours(container);
      scene.background = new Color(colours.stage);
      material = new MeshStandardMaterial({ color: colours.model, roughness: 0.7, metalness: 0.05 });
      grid = buildPlaneGrid(Math.max(modelSize.x, modelSize.y), container); setStep(Number((grid.userData.step as number).toPrecision(3)));
      scene.add(new Mesh(geometry, material), grid, new AmbientLight(0xffffff, 1.6));
      const key = new DirectionalLight(0xffffff, 2.6); key.position.set(-1, -1.4, 2).multiplyScalar(extent); scene.add(key);
      const fill = new DirectionalLight(0xffffff, 1.1); fill.position.set(1.2, 1, 0.8).multiplyScalar(extent); scene.add(fill);
      // Z-up like CAD and slicers, matching the assembly explorer.
      const camera = new PerspectiveCamera(40, 1, extent / 1000, extent * 100);
      camera.up.set(0, 0, 1);
      camera.position.set(extent * 1.3, -extent * 1.7, extent * 1.2);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(0, 0, modelSize.z / 2);
      controls.minDistance = extent * 0.1; controls.maxDistance = extent * 20;
      controls.update(); controls.saveState();
      const render = () => { if (!disposed) renderer!.render(scene, camera); };
      reset.current = () => { controls!.reset(); render(); };
      controls.addEventListener("change", render);
      themeObserver = new MutationObserver(() => { const next = viewerColours(container); scene.background = new Color(next.stage); material!.color.set(next.model); const old = grid; grid = buildPlaneGrid(Math.max(modelSize.x, modelSize.y), container); scene.remove(old!); disposeGrid(old); scene.add(grid); render(); });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      const resize = () => {
        const width = Math.max(container.clientWidth, 1), height = Math.max(container.clientHeight, 1);
        renderer!.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); render();
      };
      observer = new ResizeObserver(resize); observer.observe(container); resize();
    } catch (cause) { dispose(); setError(cause instanceof Error ? cause.message : "The 3D viewer is unavailable. Download the STL to view it locally."); }
    return () => { reset.current = () => undefined; dispose(); };
  }, [bytes, attempt]);
  return <div className="viewer-preview">
    {error ? <div><Alert asChild><p role="alert">{error}</p></Alert><Button variant="outline" type="button" className="button button-secondary" onClick={() => setAttempt(value => value + 1)}>Retry STL preview</Button></div> : <div className="viewer-toolbar"><p className="viewer-readout">{size && <><strong>{formatModelSize(size)}</strong><span>Model bounds · Z up{step ? ` · grid ${step} mm` : ""}</span></>}</p><Button variant="outline" type="button" className="button button-secondary" onClick={() => reset.current()}>Reset view</Button></div>}
    <div ref={host} className="artifact-preview-stl viewer-stage" hidden={Boolean(error)} />
    {!error && <p className="viewer-hint">Drag to rotate. Scroll or pinch to zoom. Units assumed to be millimetres; this view does not check printability or fit.</p>}
  </div>;
}
