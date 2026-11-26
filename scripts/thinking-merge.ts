import fs from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { writeJsonFile } from '../utils'

export const MONTHS_DIR = './data/thinking/months'
export const INDEX_PATH = './data/thinking/index.json'
/** 演示数据，不入库：只想看排版时用 `--sample` 生成 index.dev.json */
export const SAMPLE_DIR = './data/thinking/sample'
export const DEV_INDEX_PATH = './data/thinking/index.dev.json'

export type ThinkingRefType = 'watched' | 'reading' | 'quote' | 'link' | 'music' | 'repo'

export interface ThinkingRef {
  type: ThinkingRefType
  url: string
  title?: string
  subtitle?: string
  /** 豆瓣评分，十分制，只有影视和书会带 */
  rating?: number
  /** 仓库的 star 数，只有 type=repo 时出现 */
  stars?: number
  description?: string
  cover?: string
  quote?: string
}

export interface ThinkingEntry {
  timestamp: string
  text?: string
  images?: string[]
  ref?: ThinkingRef
}

interface MonthFile {
  version?: number
  entries?: ThinkingEntry[]
}

/** 一律转成东八区、毫秒精度的 ISO 串，长度固定，字典序等于时间序 */
export function normalizeTimestamp(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime()))
    throw new Error(`Invalid timestamp: ${String(input)}`)
  const shifted = new Date(date.getTime() + 8 * 3600_000)
  return `${shifted.toISOString().slice(0, 23)}+08:00`
}

export function monthOf(timestamp: string): string {
  return timestamp.slice(0, 7)
}

export function monthPathFor(timestamp: string): string {
  return `${MONTHS_DIR}/${monthOf(timestamp)}.json`
}

export function normalizeEntry(entry: ThinkingEntry): ThinkingEntry {
  const normalized: ThinkingEntry = { timestamp: normalizeTimestamp(entry.timestamp) }
  const text = entry.text?.trim()
  if (text)
    normalized.text = text
  if (entry.images?.length)
    normalized.images = [...entry.images]
  if (entry.ref?.url) {
    const { type, url, title, subtitle, rating, stars, description, cover, quote } = entry.ref
    normalized.ref = {
      type,
      url,
      ...(title ? { title } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(typeof rating === 'number' ? { rating } : {}),
      ...(typeof stars === 'number' ? { stars } : {}),
      ...(description ? { description } : {}),
      ...(cover ? { cover } : {}),
      ...(quote ? { quote } : {}),
    }
  }
  return normalized
}

export function sortEntries(entries: ThinkingEntry[]): ThinkingEntry[] {
  return [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp))
}

export function readMonth(file: string): ThinkingEntry[] {
  if (!fs.existsSync(file))
    return []
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as MonthFile | ThinkingEntry[]
  const list = Array.isArray(raw) ? raw : raw.entries ?? []
  return list.filter(entry => entry?.timestamp).map(normalizeEntry)
}

export function monthFiles(dir = MONTHS_DIR): string[] {
  if (!fs.existsSync(dir))
    return []
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    // 拼成 '<dir>/<file>' 而不是 path.join，避免 Windows 上冒出反斜杠
    .map(name => `${dir}/${name}`)
}

export function readAllEntries(dir = MONTHS_DIR): ThinkingEntry[] {
  const seen = new Set<string>()
  const entries: ThinkingEntry[] = []
  for (const file of monthFiles(dir)) {
    for (const entry of readMonth(file)) {
      if (seen.has(entry.timestamp)) {
        console.warn(`[thinking] duplicate timestamp ${entry.timestamp} in ${file}, skipped`)
        continue
      }
      seen.add(entry.timestamp)
      entries.push(entry)
    }
  }
  return sortEntries(entries)
}

export async function writeMonth(file: string, entries: ThinkingEntry[]) {
  await writeJsonFile(file, { version: 1, entries: sortEntries(entries) })
}

export async function mergeThinking(options: { sample?: boolean } = {}) {
  const dir = options.sample ? SAMPLE_DIR : MONTHS_DIR
  const out = options.sample ? DEV_INDEX_PATH : INDEX_PATH
  const entries = readAllEntries(dir)
  await writeJsonFile(out, { version: 1, count: entries.length, entries })
  const months = new Set(entries.map(entry => monthOf(entry.timestamp)))
  console.log(`[thinking] merged ${entries.length} entries from ${months.size} months into ${out}`)
  return { count: entries.length, months: months.size }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await mergeThinking({ sample: process.argv.includes('--sample') })
