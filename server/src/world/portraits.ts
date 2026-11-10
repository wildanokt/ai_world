import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "ulid";

export const MAX_PORTRAIT_BYTES = 5 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const portraitId = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function portraitType(bytes: Buffer): string | null {
  if (bytes.length < 12 || bytes.length > MAX_PORTRAIT_BYTES) return null;
  if (bytes.subarray(0, 8).equals(PNG)) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export function portraits(directory: string) {
  return {
    async save(bytes: Buffer) {
      if (!portraitType(bytes)) return null;
      const id = ulid();
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, id), bytes, { flag: "wx" });
      return id;
    },
    async load(id: string) {
      if (!portraitId.test(id)) return null;
      try { return await readFile(join(directory, id)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return null;
      }
    },
  };
}
