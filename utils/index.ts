import fs from 'node:fs/promises'
import axios from 'axios'

export async function writeJsonFile(filePath: string, data: any) {
  const dir = filePath.substring(0, filePath.lastIndexOf('/'))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

export async function downloadImage(
  url: string,
  savePath: string,
  skipIfExists: boolean = false,
) {
  if (skipIfExists) {
    try {
      await fs.access(savePath)
      return
    }
    catch {
    }
  }

  const response = await axios.get(url, { responseType: 'arraybuffer' })
  await fs.writeFile(savePath, response.data)
}
