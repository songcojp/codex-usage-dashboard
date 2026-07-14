import fs from "node:fs/promises";
import path from "node:path";

export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  mode = 0o600
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(tempPath, "w", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, mode);
    await syncDirectory(dir);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
