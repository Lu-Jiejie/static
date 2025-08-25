import fs from 'node:fs/promises'

export async function writeJsonFile(filePath: string, data: any) {
  const dir = filePath.substring(0, filePath.lastIndexOf('/'))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}
