import { parentPort, workerData } from "node:worker_threads";
import { parseAssemblyFile } from "./assembly-parser.js";
void parseAssemblyFile(workerData.bytes, workerData.filename, workerData.unit, workerData.upAxis).then(result => parentPort?.postMessage(result)).catch(error => {
  // Parser messages are controlled, but upstream CAD errors can contain private data.
  const message = error instanceof Error && /^(Use |Model |Invalid |Unsupported |Truncated |Multiple |Export |Missing |GLB |STL |STEP )/u.test(error.message) ? error.message : "Model could not be read. Check the file or export a simpler assembly.";
  parentPort?.postMessage({ error: message, warnings: [] });
});
