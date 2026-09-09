import { useEffect, useRef, useState } from "react";
import { AmbientLight, Color, DirectionalLight, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

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
  const size = geometry.boundingBox!.getSize(new Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(extent) || extent <= 0) { geometry.dispose(); throw new Error("This STL has no viewable geometry."); }
  geometry.center();
  geometry.scale(2 / extent, 2 / extent, 2 / extent);
  geometry.computeVertexNormals();
  return geometry;
}

export default function StlPreview({ bytes }: { bytes: ArrayBuffer }) {
  const host = useRef<HTMLDivElement>(null);
  const reset = useRef<() => void>(() => undefined);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let renderer: WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let observer: ResizeObserver | undefined;
    let geometry: ReturnType<typeof readStlGeometry> | undefined;
    let material: MeshStandardMaterial | undefined;
    let disposed = false;
    const dispose = () => { if (disposed) return; disposed = true; observer?.disconnect(); controls?.dispose(); geometry?.dispose(); material?.dispose(); renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove(); };
    try {
      geometry = readStlGeometry(bytes);
      renderer = new WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.domElement.setAttribute("aria-label", "STL model preview");
      renderer.domElement.setAttribute("role", "img");
      container.append(renderer.domElement);
      const scene = new Scene();
      scene.background = new Color("#edf2f3");
      material = new MeshStandardMaterial({ color: "#477b84", roughness: 0.65 });
      scene.add(new Mesh(geometry, material), new AmbientLight(0xffffff, 2));
      const light = new DirectionalLight(0xffffff, 3); light.position.set(3, 5, 4); scene.add(light);
      const camera = new PerspectiveCamera(45, 1, 0.01, 100);
      camera.position.set(3, 2, 3);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.minDistance = 0.2; controls.maxDistance = 20;
      controls.saveState();
      const render = () => renderer!.render(scene, camera);
      reset.current = () => { controls!.reset(); render(); };
      controls.addEventListener("change", render);
      const resize = () => {
        const width = Math.max(container.clientWidth, 1), height = Math.max(container.clientHeight, 1);
        renderer!.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); render();
      };
      observer = new ResizeObserver(resize); observer.observe(container); resize();
    } catch (cause) { dispose(); setError(cause instanceof Error ? cause.message : "The 3D viewer is unavailable. Download the STL to view it locally."); }
    return dispose;
  }, [bytes]);
  return error ? <p role="alert">{error}</p> : <div><p>Drag to rotate. Scroll or pinch to zoom. This preview does not verify printability or physical fit.</p><button type="button" className="button button-quiet" onClick={() => reset.current()}>Reset view</button><div ref={host} className="artifact-preview-stl" /></div>;
}
