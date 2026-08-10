import * as fs from "node:fs";
import * as path from "node:path";

export function appendJsonLines(filePath: string, lines: string[]): void {
  if (!lines.length) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, "a+");
  try {
    const size = fs.fstatSync(descriptor).size;
    const separator = size > 0 && readLastByte(descriptor, size) !== 0x0a ? "\n" : "";
    fs.writeSync(descriptor, `${separator}${lines.join("\n")}\n`, null, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function readLastByte(descriptor: number, size: number): number {
  const lastByte = Buffer.allocUnsafe(1);
  fs.readSync(descriptor, lastByte, 0, 1, size - 1);
  return lastByte[0]!;
}
