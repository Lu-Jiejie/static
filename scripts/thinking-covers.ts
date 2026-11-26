import fs from 'node:fs/promises'
import axios from 'axios'
import 'dotenv/config'

/**
 * 只下豆瓣的图。豆瓣图床有防盗链：没有 Referer 回 418、博客自己的 Referer 回 403，
 * 只有 douban 自己的 Referer 才给图，前端和图片代理都拿不到，只能存进仓库。
 * 其它站点直接存外链。
 */
export const COVERS_DIR = './data/thinking/covers'
export const FAVICONS_DIR = './data/thinking/favicons'
export const DOUBAN_FAVICON_PATH = 'favicons/douban.ico'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const DOUBAN_REFERER = 'https://movie.douban.com/'
// www.douban.com 的 favicon 对爬虫也回 403，静态资源域倒是给了
const DOUBAN_FAVICON = 'https://img3.doubanio.com/favicon.ico'

function isDouban(url: string) {
  const host = new URL(url).hostname
  return host.endsWith('doubanio.com') || host.endsWith('douban.com')
}

/** 2026-11-26T12:04:54.582+08:00 -> 20261126-120454582 */
function stampOf(timestamp: string) {
  const date = timestamp.slice(0, 10).replace(/-/g, '')
  const time = timestamp.slice(11, 23).replace(/[:.]/g, '')
  return `${date}-${time}`
}

function extensionOf(url: string) {
  const match = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i)
  if (!match)
    return '.jpg'
  return `.${match[1].toLowerCase().replace('jpeg', 'jpg')}`
}

async function download(url: string, referer?: string) {
  const headers: Record<string, string> = { 'User-Agent': UA }
  if (referer)
    headers.Referer = referer
  const res = await axios.get(url, { headers, responseType: 'arraybuffer', timeout: 20_000 })
  return Buffer.from(res.data)
}

/**
 * 豆瓣封面存成 `covers/<时间戳>.<ext>`，返回写进 JSON 的相对路径。
 * 失败就退回外链，至少没把这条记录搞坏。
 */
export async function saveCover(coverUrl: string, timestamp: string): Promise<string> {
  if (!/^https?:\/\//.test(coverUrl) || !isDouban(coverUrl))
    return coverUrl

  const fileName = `${stampOf(timestamp)}${extensionOf(coverUrl)}`
  try {
    const buffer = await download(coverUrl, DOUBAN_REFERER)
    await fs.mkdir(COVERS_DIR, { recursive: true })
    await fs.writeFile(`${COVERS_DIR}/${fileName}`, buffer)
    return `covers/${fileName}`
  }
  catch (err) {
    console.warn(`[cover] ${coverUrl} 下载失败：${(err as Error).message}，先用外链顶上`)
    return coverUrl
  }
}

/** 豆瓣的 favicon 同样带防盗链，仓库里留一份给前端兜底用 */
export async function saveDoubanFavicon(): Promise<void> {
  const file = `${FAVICONS_DIR}/douban.ico`
  try {
    await fs.access(file)
    return
  }
  catch {}

  try {
    const buffer = await download(DOUBAN_FAVICON, DOUBAN_REFERER)
    await fs.mkdir(FAVICONS_DIR, { recursive: true })
    await fs.writeFile(file, buffer)
  }
  catch (err) {
    console.warn(`[favicon] 豆瓣图标下载失败：${(err as Error).message}`)
  }
}
