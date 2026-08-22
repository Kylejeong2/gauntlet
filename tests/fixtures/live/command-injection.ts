import { exec } from "node:child_process";

export const greet = (name: string): void => {
  exec(`echo Hello ${name}`);
};
