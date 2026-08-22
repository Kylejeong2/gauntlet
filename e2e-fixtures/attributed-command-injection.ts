import { exec } from "node:child_process";

export const archiveReport = (archiveName: string): void => {
  exec(`tar -czf ${archiveName}.tgz reports/`);
};
