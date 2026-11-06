import { open } from 'node:fs/promises';

// Bounded JSON file reader shared by source clients. Never follows a path from
// the browser and never writes to the file it inspects.
export async function boundedJsonFile(path: string, limit = 4 * 1024 * 1024): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Store exceeds file bounds');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, limit + 1, 0);
    if (bytesRead > limit) throw new Error('Store exceeds file bounds');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await file.close();
  }
}
