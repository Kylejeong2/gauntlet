import { readFile } from "node:fs/promises";
import { join } from "node:path";

const exportRoot = "/srv/exports";

export const downloadExport = async (requestedPath: string): Promise<Buffer> =>
  readFile(join(exportRoot, requestedPath));
