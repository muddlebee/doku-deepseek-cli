import { tsImport } from "tsx/esm/api";

await tsImport("./sample-worker.ts", import.meta.url);
