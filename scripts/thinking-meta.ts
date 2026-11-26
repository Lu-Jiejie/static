import process from 'node:process'
import axios from 'axios'
import { load } from 'cheerio'
import 'dotenv/config'
import type { ThinkingRef, ThinkingRefType } from './thinking-merge'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'

// 站点常拿 "-"「暂无简介」这类占位糊弄爬虫，当成没有
const PLACEHOLDER = /^(?:[-—–_~·。.\s]+|无|暂无简介|暂无描述|无简介|none|null|undefined|n\/a)$/i

function truncate(text: string | undefined, length = 120) {
  if (!text)
    return undefined
  const clean = text.replace(/\s+/g, ' ').trim().replace(/^简介[:：]\s*/, '')
  if (!clean || PLACEHOLDER.test(clean))
    return undefined
  return clean.length > length ? `${clean.slice(0, length)}…` : clean
}

function defaultType(hostname: string): ThinkingRefType {
  const host = hostname.replace(/^www\./, '')
  if (host === 'b23.tv' || host.endsWith('bilibili.com'))
    return 'watched'
  if (host.endsWith('youtube.com') || host === 'youtu.be')
    return 'watched'
  if (host.endsWith('book.douban.com'))
    return 'reading'
  if (host.endsWith('douban.com') || host.endsWith('themoviedb.org'))
    return 'watched'
  if (host.endsWith('bangumi.tv') || host.endsWith('bgm.tv'))
    return 'watched'
  if (host.endsWith('music.163.com'))
    return 'music'
  if (host.endsWith('github.com'))
    return 'repo'
  return 'link'
}

async function followRedirect(url: string) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA },
      timeout: 10_000,
      maxRedirects: 5,
    })
    return res.request?.res?.responseUrl ?? url
  }
  catch {
    return url
  }
}

async function bilibiliMeta(url: string): Promise<Partial<ThinkingRef>> {
  const finalUrl = url.includes('b23.tv') ? await followRedirect(url) : url
  const bv = finalUrl.match(/BV[0-9A-Za-z]{10}/)?.[0]
  if (!bv)
    return {}
  const res = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    timeout: 10_000,
  })
  const data = res.data?.data
  if (!data)
    return {}
  const minutes = Math.floor((data.duration ?? 0) / 60)
  const seconds = String((data.duration ?? 0) % 60).padStart(2, '0')
  return {
    title: data.title,
    subtitle: `${data.owner?.name ?? ''}${data.duration ? ` · ${minutes}:${seconds}` : ''}`,
    description: truncate(data.desc, 90) ?? truncate(data.dynamic, 90),
    cover: data.pic?.replace(/^http:/, 'https:'),
  }
}

async function youtubeMeta(url: string): Promise<Partial<ThinkingRef>> {
  const res = await axios.get(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
    timeout: 10_000,
  })
  // oEmbed 只有标题和频道，简介得回页面里捞
  const description = await openGraphMeta(url).then(meta => meta.description).catch(() => undefined)
  return {
    title: res.data?.title,
    subtitle: res.data?.author_name,
    description,
    cover: res.data?.thumbnail_url,
  }
}

async function bangumiMeta(url: string): Promise<Partial<ThinkingRef>> {
  const id = url.match(/subject\/(\d+)/)?.[1]
  if (!id)
    return {}
  const res = await axios.get(`https://api.bgm.tv/v0/subjects/${id}`, {
    headers: { 'User-Agent': process.env.BANGUMI_USER_AGENT || 'Lu-Jiejie/blog' },
    timeout: 10_000,
  })
  const data = res.data
  const date = data?.date ? (data.date as string).slice(0, 4) : ''
  return {
    title: data?.name_cn || data?.name,
    subtitle: [data?.name_cn ? data?.name : data?.platform, date].filter(Boolean).join(' · ') || undefined,
    description: truncate(data?.summary, 90),
    cover: data?.images?.large,
  }
}

// 豆瓣网页版对爬虫一律 403 跳登录页，但移动端 rexxar 接口不需要登录，字段还全
async function doubanMeta(url: string): Promise<Partial<ThinkingRef>> {
  const id = url.match(/\/subject\/(\d+)/)?.[1]
  if (!id)
    return {}
  const isBook = /book\.douban\.com/.test(url) || url.includes('/book/subject/')
  const res = await axios.get(`https://m.douban.com/rexxar/api/v2/${isBook ? 'book' : 'movie'}/${id}`, {
    headers: { 'User-Agent': UA, Referer: `https://m.douban.com/${isBook ? 'book' : 'movie'}/subject/${id}/` },
    timeout: 10_000,
  })
  const data = res.data
  if (!data?.title)
    return {}
  const year = data.year || data.pubdate?.[0]?.slice(0, 4)
  const rating = typeof data.rating?.value === 'number' && data.rating.value > 0 ? data.rating.value : undefined
  return {
    title: data.title,
    subtitle: isBook
      ? ['书籍', data.author?.[0], year].filter(Boolean).join(' · ')
      : [data.type === 'tv' ? '剧集' : '电影', year].filter(Boolean).join(' · '),
    rating,
    description: truncate(data.intro, 90),
    cover: data.pic?.large || data.cover_url,
  }
}

async function neteaseMeta(url: string): Promise<Partial<ThinkingRef>> {
  const id = url.match(/[?&]id=(\d+)/)?.[1] ?? url.match(/\/song\/(\d+)/)?.[1]
  if (!id)
    return {}
  const res = await axios.get(`https://music.163.com/api/song/detail?ids=[${id}]`, {
    headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
    timeout: 10_000,
  })
  const song = res.data?.songs?.[0]
  if (!song)
    return {}
  return {
    title: song.name,
    subtitle: (song.artists ?? []).map((artist: any) => artist.name).join(' / ') || undefined,
    cover: song.album?.picUrl,
  }
}

async function githubMeta(url: string): Promise<Partial<ThinkingRef>> {
  const [, owner, repo] = url.match(/github\.com\/([^/]+)\/([^/?#]+)/) ?? []
  if (!owner || !repo)
    return {}
  const res = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      'User-Agent': UA,
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    timeout: 10_000,
  })
  const stars = res.data?.stargazers_count
  return {
    title: res.data?.full_name,
    subtitle: res.data?.language || undefined,
    stars: typeof stars === 'number' && stars > 0 ? stars : undefined,
    description: truncate(res.data?.description, 90),
    cover: res.data?.owner?.avatar_url,
  }
}

// 贴吧桌面页是前端渲染的空壳，且没有 cookie 会跳「百度安全验证」；
// 移动版才是服务端渲染，随便带个 BAIDUID 就能过
async function tiebaMeta(url: string): Promise<Partial<ThinkingRef>> {
  const tid = url.match(/kz=(\d+)/)?.[1] ?? url.match(/\/p\/(\d+)/)?.[1]
  if (!tid)
    return {}
  const res = await axios.get(`https://tieba.baidu.com/mo/q/m?kz=${tid}`, {
    headers: {
      'User-Agent': MOBILE_UA,
      'Cookie': 'BAIDUID=0F1A2B3C4D5E6F708192A3B4C5D6E7F8:FG=1',
      'Referer': 'https://tieba.baidu.com/',
    },
    timeout: 12_000,
    maxRedirects: 5,
  })
  const $ = load(res.data)
  const title = $('#po_list .post_title_embed').first().text().trim() || $('title').text().trim()
  const author = $('.list_item_user_wrap .user_name').first().text().trim()
  const body = $('#po_list .list_item_wrapper .content').first().text()
  return {
    title: title && title !== '百度贴吧' ? title : undefined,
    subtitle: author ? `贴吧 · ${author}` : '贴吧',
    description: truncate(body, 90),
  }
}

async function openGraphMeta(url: string): Promise<Partial<ThinkingRef>> {
  const res = await axios.get(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    timeout: 12_000,
    maxRedirects: 5,
  })
  const $ = load(res.data)
  const pick = (selector: string) => $(selector).attr('content')?.trim() || undefined
  const title = pick('meta[property="og:title"]')
    || pick('meta[name="twitter:title"]')
    || $('title').text().trim()
    || undefined
  const ogDescription = pick('meta[property="og:description"]')
    || pick('meta[name="description"]')
    || pick('meta[name="twitter:description"]')
  const cover = pick('meta[property="og:image"]') || pick('meta[name="twitter:image"]')
  return {
    title,
    description: truncate(ogDescription, 90),
    cover: cover && /^https?:\/\//.test(cover) ? cover : undefined,
  }
}

/**
 * 按域名挑一条元数据来源；任何一步失败都退化，不阻塞写入。
 */
export async function resolveRefMeta(url: string, hint?: ThinkingRefType): Promise<ThinkingRef> {
  const parsed = new URL(url)
  const host = parsed.hostname
  const ref: ThinkingRef = {
    type: hint ?? defaultType(host),
    url,
  }

  const handlers: Array<[RegExp, (url: string) => Promise<Partial<ThinkingRef>>]> = [
    [/(^|\.)b23\.tv$|bilibili\.com$/, bilibiliMeta],
    [/youtube\.com$|youtu\.be$/, youtubeMeta],
    [/bangumi\.tv$|bgm\.tv$/, bangumiMeta],
    [/douban\.com$/, doubanMeta],
    [/music\.163\.com$/, neteaseMeta],
    [/github\.com$/, githubMeta],
    [/tieba\.baidu\.com$/, tiebaMeta],
  ]

  const handler = handlers.find(([pattern]) => pattern.test(host))?.[1] ?? openGraphMeta
  try {
    Object.assign(ref, prune(await handler(url)))
  }
  catch (err) {
    console.warn(`[meta] ${url} failed: ${(err as Error).message}`)
    try {
      if (handler !== openGraphMeta)
        Object.assign(ref, prune(await openGraphMeta(url)))
    }
    catch {
      console.warn(`[meta] ${url} open graph fallback also failed, keeping bare link`)
    }
  }
  return ref
}

function prune(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  )
}
