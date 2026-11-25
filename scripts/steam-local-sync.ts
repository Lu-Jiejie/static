import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import axios from 'axios'
import { writeJsonFile } from '../utils'

interface LocalHistoryEntry {
  playtime: number
  lastPlayed: number
  name?: string
  cover?: string
  link?: string
  linkZh?: string
}

interface GameLinkConfig {
  link?: string
  linkZh?: string
}

interface LocalHistoryData {
  [appId: string]: LocalHistoryEntry
}

interface ExtraGameConfig {
  appId?: string | number
  name?: string
  nameZh?: string
  playtime: number | string
  lastPlayed: number | string
  cover?: string
  link?: string
  linkZh?: string
}

interface LocalSyncConfig {
  vdfPath: string
  fakeAppIds: number[]
  extraGames: ExtraGameConfig[]
  shortcutsPath?: string
  gridPath?: string
  sgdbApiKey?: string
  // 非 PC 游戏的页面链接，key 是 appId；extraGames 里也能单独写
  links?: Record<string, GameLinkConfig>
}

interface ShortcutEntry {
  appId: number
  name: string
  lastPlayTime: number
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, './config.json')
const HISTORY_PATH = './data/steam/games_local.json'
const NAMEZH_CUSTOM_PATH = './data/steam/namezh_map_custom.json'
const COVERS_DIR = './data/steam/covers'
const COVER_EXTS = ['jpg', 'png', 'jpeg', 'webp']

// SRM ships this key in src/lib/image-providers/api-key.ts
const DEFAULT_SGDB_KEY = 'f80f92019254471cca9d62ff91c21eee'
const SGDB_API = 'https://www.steamgriddb.com/api/v2'

const DRY_RUN = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')

function readConfig(): LocalSyncConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw)
  }
  catch {
    throw new Error(
      `Missing config file: ${CONFIG_PATH}\n`
      + 'Create it with your Steam local config.',
    )
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  }
  catch {
    return fallback
  }
}

function readVdfFile(vdfPath: string): string[] {
  return fs.readFileSync(vdfPath, 'utf-8').split('\n')
}

function extractAppDataFromVdf(lines: string[], appId: string): { playtime: number, lastPlayed: number } | null {
  let playtime = 0
  let lastPlayed = 0
  let inTargetApp = false
  let bracketCount = 0

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === `"${appId}"`) {
      inTargetApp = true
      bracketCount = 0
      continue
    }

    if (inTargetApp) {
      if (trimmed.includes('{')) bracketCount++
      if (trimmed.includes('}')) bracketCount--

      const playtimeMatch = trimmed.match(/"Playtime"\s*"(\d+)"/)
      if (playtimeMatch) playtime = Number(playtimeMatch[1])

      const lastPlayedMatch = trimmed.match(/"LastPlayed"\s*"(\d+)"/)
      if (lastPlayedMatch) lastPlayed = Number(lastPlayedMatch[1])

      if (bracketCount === 0 && trimmed === '}') {
        break
      }
    }
  }

  if (playtime > 0 || lastPlayed > 0) {
    return { playtime, lastPlayed }
  }
  return null
}

// shortcuts are stored as signed int32 by Steam; localconfig is keyed by that same signed form
function toSignedAppId(appId: number): number {
  return appId > 0x7FFFFFFF ? appId - 0x100000000 : appId
}

// shortcuts.vdf is binary VDF: [type][key\0][value], 0x08 closes a map
function parseShortcutsVdf(filePath: string): ShortcutEntry[] {
  if (!fs.existsSync(filePath)) {
    return []
  }

  const buf = fs.readFileSync(filePath)
  let pos = 0

  const readCString = () => {
    const end = buf.indexOf(0x00, pos)
    const value = buf.toString('utf8', pos, end)
    pos = end + 1
    return value
  }

  const readMap = (): Record<string, any> => {
    const map: Record<string, any> = {}
    while (buf[pos] !== 0x08) {
      const type = buf[pos++]
      const key = readCString()
      if (type === 0x00) map[key] = readMap()
      else if (type === 0x01) map[key] = readCString()
      else if (type === 0x02) {
        map[key] = buf.readInt32LE(pos)
        pos += 4
      }
      else if (type === 0x07) {
        map[key] = buf.readBigUInt64LE(pos).toString()
        pos += 8
      }
      else {
        throw new Error(`shortcuts.vdf: unsupported type 0x${type.toString(16)} at ${pos}`)
      }
    }
    pos++
    return map
  }

  if (buf[pos] !== 0x00) {
    throw new Error('shortcuts.vdf: root is not a map')
  }
  pos++
  const rootKey = readCString()
  if (rootKey !== 'shortcuts') {
    console.warn(`shortcuts.vdf: unexpected root key "${rootKey}"`)
  }
  // readMap already returns the contents of the "shortcuts" map
  const root = readMap()

  return Object.values(root).map((item: any) => ({
    appId: item.appid >>> 0,
    name: item.appname ?? '',
    lastPlayTime: Number(item.LastPlayTime ?? 0),
  }))
}

// Some SRM parsers name the artwork with a 64-bit id instead of the raw appid
function toArtworkId(appId: number): string {
  return (BigInt(appId) * BigInt(4294967296) + BigInt(33554432)).toString()
}

function existingCover(appId: string): string | null {
  for (const ext of COVER_EXTS) {
    if (fs.existsSync(path.join(COVERS_DIR, `${appId}.${ext}`))) {
      return `data/steam/covers/${appId}.${ext}`
    }
  }
  return null
}

function writeCover(appId: string, ext: string, data: Buffer): string {
  const relative = `data/steam/covers/${appId}.${ext}`
  if (DRY_RUN) {
    return relative
  }

  fs.mkdirSync(COVERS_DIR, { recursive: true })
  fs.writeFileSync(path.join(COVERS_DIR, `${appId}.${ext}`), data)

  for (const other of COVER_EXTS) {
    if (other !== ext && fs.existsSync(path.join(COVERS_DIR, `${appId}.${other}`))) {
      fs.rmSync(path.join(COVERS_DIR, `${appId}.${other}`))
    }
  }
  return relative
}

function copyCover(appId: string, source: string): string {
  const ext = (path.extname(source).slice(1) || 'jpg').toLowerCase().replace('jpeg', 'jpg')
  return writeCover(appId, ext, fs.readFileSync(source))
}

// Copies artwork Steam/SRM already downloaded into the repo
function syncGridCover(appId: number, gridPath: string): string | null {
  for (const name of [String(appId), toArtworkId(appId)]) {
    for (const ext of COVER_EXTS) {
      const source = path.join(gridPath, `${name}.${ext}`)
      if (fs.existsSync(source)) {
        return copyCover(String(appId), source)
      }
    }
  }
  return null
}

async function searchSgdbGrid(title: string, apiKey: string): Promise<string | null> {
  const headers = { Authorization: `Bearer ${apiKey}` }
  const { data: search } = await axios.get(
    `${SGDB_API}/search/autocomplete/${encodeURIComponent(title)}`,
    { headers, timeout: 20000 },
  )
  const game = search?.data?.[0]
  if (!game) {
    return null
  }

  const { data: grids } = await axios.get(
    `${SGDB_API}/grids/game/${game.id}`,
    { headers, timeout: 20000 },
  )
  const list: any[] = grids?.data ?? []
  // 920x430 is what the blog card renders; 460x215 is the same ratio
  const best = list.find(g => g.width === 920 && g.height === 430)
    ?? list.find(g => g.width === 460 && g.height === 215)
    ?? list[0]

  if (!best?.url) {
    return null
  }
  console.log(`  [Cover] sgdb match "${game.name}" -> ${best.width}x${best.height}`)
  return best.url
}

async function downloadCover(appId: string, url: string): Promise<string> {
  const match = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif)$/i)
  const ext = match ? match[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'

  const { data } = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  return writeCover(appId, ext, Buffer.from(data))
}

// 列出 SteamGridDB 上的候选封面，供手动挑选（不下载、不写文件）
async function listCovers(title: string, apiKey: string) {
  const headers = { Authorization: `Bearer ${apiKey}` }
  const { data: search } = await axios.get(
    `${SGDB_API}/search/autocomplete/${encodeURIComponent(title)}`,
    { headers, timeout: 20000 },
  )
  const game = search?.data?.[0]
  if (!game) {
    console.log(`没有搜到 "${title}"`)
    return
  }

  const { data: grids } = await axios.get(
    `${SGDB_API}/grids/game/${game.id}`,
    { headers, timeout: 20000 },
  )
  const list: any[] = grids?.data ?? []
  const wide = list.filter(g => g.width === 920 && g.height === 430)
  const shown = wide.length ? wide : list

  console.log(`"${game.name}" (sgdb game ${game.id}) 共 ${list.length} 张，其中 920x430 有 ${wide.length} 张\n`)
  shown.forEach((g: any) => {
    console.log(`  ${String(g.id).padEnd(8)} ${String(`${g.width}x${g.height}`).padEnd(10)} ${g.mime.replace('image/', '').padEnd(5)} ${g.author?.name ?? '?'}`)
    console.log(`           ${g.url}`)
  })
  console.log('\n挑好后把 url 填到 extraGames[].cover，或直接下载图片放进 data/steam/covers/')
}

/**
 * cover 取值：
 *  - 省略     -> 已有封面 > SRM 的 grid 图 > 自动去 SteamGridDB 搜一张
 *  - "sgdb"   -> 直接去 SteamGridDB 搜
 *  - http(s)  -> 下载该 URL
 *  - 其它     -> 当作本地文件路径复制进来
 *
 * 无论如何，covers/ 里已有的文件都不会被覆盖（除非 --force），
 * 这样你自己换的图能一直留着。
 */
async function resolveCover(
  appId: string,
  cover: string | undefined,
  title: string | undefined,
  gridPath: string,
  apiKey: string,
): Promise<string | null> {
  // 手动放的图优先，永不覆盖
  if (!FORCE) {
    const already = existingCover(appId)
    if (already) {
      return already
    }
  }

  if (cover && /^https?:\/\//i.test(cover)) {
    return downloadCover(appId, cover)
  }

  if (cover && cover !== 'sgdb') {
    if (!fs.existsSync(cover)) {
      console.warn(`  [Cover] ${appId}: local file not found: ${cover}`)
      return null
    }
    return copyCover(appId, cover)
  }

  // 没指定来源：先蹭 SRM 已经下好的图
  if (!cover && gridPath) {
    const fromGrid = syncGridCover(Number(appId), gridPath)
    if (fromGrid) {
      return fromGrid
    }
  }

  // 再不行就去 SteamGridDB 搜
  return autoCover(appId, title, apiKey)
}

// 按名字去 SteamGridDB 抓一张 920x430 的封面
async function autoCover(appId: string, title: string | undefined, apiKey: string): Promise<string | null> {
  if (!title) {
    return null
  }
  try {
    const url = await searchSgdbGrid(title, apiKey)
    if (!url) {
      console.warn(`  [Cover] ${appId}: SteamGridDB 没搜到 "${title}"`)
      return null
    }
    return downloadCover(appId, url)
  }
  catch (err) {
    console.warn(`  [Cover] ${appId}: 抓封面失败 (${(err as Error).message})`)
    return null
  }
}

// Non-Steam appids live above 2^31, so the high bit keeps generated ids out of Steam's range
function stableAppId(seed: string): number {
  let hash = 0x811C9DC5
  for (const char of seed) {
    hash ^= char.codePointAt(0) as number
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash | 0x80000000) >>> 0
}

function toMinutes(value: number | string): number {
  if (typeof value === 'number') {
    return Math.round(value)
  }
  const hours = value.trim().match(/^([\d.]+)\s*h(?:ours?)?$/i)
  if (hours) {
    return Math.round(Number(hours[1]) * 60)
  }
  return Math.round(Number(value))
}

function toTimestamp(value: number | string): number {
  if (typeof value === 'number') {
    return Math.round(value)
  }
  const numeric = value.trim().match(/^\d+$/)
  if (numeric) {
    return Number(numeric[0])
  }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    throw new Error(`Cannot parse time: ${value}`)
  }
  return Math.floor(parsed / 1000)
}

function readExistingHistory(): LocalHistoryData {
  return readJson<LocalHistoryData>(HISTORY_PATH, {})
}

// Steam 商店页面探测：真有页面返回 200；没有的（模拟器游戏、编的 appId）
// 会 302 跳到商店首页 —— 这正好可以用来判断该不该手写 link。
async function hasSteamStorePage(appId: string): Promise<boolean | null> {
  try {
    const res = await axios.get(`https://store.steampowered.com/app/${appId}`, {
      maxRedirects: 0,
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: status => status < 400,
    })
    return res.status === 200
  }
  catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status
    return status ? status === 200 : null
  }
}

// 链接来源：extraGames 里写的 > config.json 的 links 表
function resolveLinks(appId: string, config: LocalSyncConfig, extra?: ExtraGameConfig): GameLinkConfig {
  const fromConfig = config.links?.[appId] ?? {}
  const link = extra?.link ?? fromConfig.link
  const linkZh = extra?.linkZh ?? fromConfig.linkZh
  return {
    ...(link ? { link } : {}),
    ...(linkZh ? { linkZh } : {}),
  }
}

// 名字里有没有汉字：没有就说明这条还是英文，缺人工补的中文名
function hasCjk(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)
}

// --check：只在本地跑。检查 link、封面、以及哪些条目还缺中文名
async function checkSteam(config: LocalSyncConfig) {
  const history = readExistingHistory()
  const nameZhCustom = readJson<Record<string, string>>(NAMEZH_CUSTOM_PATH, {})
  const nameZhMap = readJson<Record<string, string>>('./data/steam/namezh_map.json', {})
  const entries = Object.entries(history)

  if (!entries.length) {
    console.log(`${HISTORY_PATH} 里还没有记录`)
    return
  }

  console.log(`检查 ${entries.length} 条记录…\n`)

  const ok: string[] = []
  const linked: string[] = []
  const missing: string[] = []
  const failed: string[] = []
  const noCover: string[] = []

  for (const [appId, entry] of entries) {
    const title = entry.name ?? nameZhCustom[appId] ?? nameZhMap[appId] ?? ''
    const label = title ? `${appId} ${title}` : appId
    const hasPage = await hasSteamStorePage(appId)
    const configured = config.links?.[appId]?.link ?? entry.link

    if (hasPage === null) {
      failed.push(label)
    }
    else if (hasPage) {
      ok.push(label)
    }
    else if (configured) {
      linked.push(`${label} -> ${configured}`)
    }
    else {
      missing.push(label)
    }

    // 有商店页的游戏 icon 直接走 Steam CDN，只有非 Steam 游戏才需要仓库里的封面
    if (hasPage === false && !existingCover(appId)) {
      noCover.push(label)
    }
  }

  const section = (label: string, rows: string[]) => {
    if (!rows.length) return
    console.log(`${label} (${rows.length})`)
    rows.forEach(row => console.log(`  ${row}`))
    console.log('')
  }

  section('link：有商店页，自动拼', ok)
  section('link：没有商店页，已手写', linked)
  section('link：没有商店页，缺 link —— 去 config.json 的 links 里补', missing)
  section('icon：没有商店页，缺封面 —— 跑一次同步或放进 data/steam/covers', noCover)
  section('探测失败（网络问题）', failed)

  // 中文名：Steam 只给英文名的时候，games.json 里的 nameZh 会跟 name 一样是英文
  const games = readJson<Array<{ id: number | string, name?: string, nameZh?: string }>>('./data/steam/games.json', [])
  const pendingZh = games.filter((game) => {
    const zh = game.nameZh ?? ''
    return game.name && !hasCjk(zh)
  })

  const seeded: string[] = []
  if (pendingZh.length) {
    for (const game of pendingZh) {
      const key = String(game.id)
      if (!nameZhCustom[key]) {
        // 先用英文名占位，你把 value 改成中文名即可
        nameZhCustom[key] = game.name as string
        seeded.push(`${key} ${game.name}`)
      }
    }
    if (seeded.length && !DRY_RUN) {
      await writeJsonFile(NAMEZH_CUSTOM_PATH, nameZhCustom)
    }
  }

  section(
    '中文名：还是英文，去 namezh_map_custom.json 里改 value 即可',
    pendingZh.map(game => `${game.id} ${game.nameZh}`),
  )
  if (seeded.length) {
    console.log(`已把 ${seeded.length} 条补进 ${NAMEZH_CUSTOM_PATH}（value 先填的英文名，改掉就行）\n`)
  }

  console.log(
    `合计 ${entries.length} 条：`
    + `link ${ok.length} 自动 / ${linked.length} 手写 / ${missing.length} 缺，`
    + `icon ${noCover.length} 缺 / ${failed.length} 未知，`
    + `中文名 ${pendingZh.length} 条待补`,
  )
}

function merge(existingHistory: LocalHistoryData, key: string, data: LocalHistoryEntry, label: string) {
  const old = existingHistory[key] ?? { playtime: 0, lastPlayed: 0 }
  const merged: LocalHistoryEntry = {
    playtime: Math.max(old.playtime ?? 0, data.playtime),
    lastPlayed: Math.max(old.lastPlayed ?? 0, data.lastPlayed),
    ...(data.name ?? old.name ? { name: data.name ?? old.name } : {}),
    ...(data.cover ?? old.cover ? { cover: data.cover ?? old.cover } : {}),
    ...(data.link ?? old.link ? { link: data.link ?? old.link } : {}),
    ...(data.linkZh ?? old.linkZh ? { linkZh: data.linkZh ?? old.linkZh } : {}),
  }
  existingHistory[key] = merged
  console.log(
    `[${label}] ${key} ${merged.name ?? ''}: `
    + `${merged.playtime}min, last: ${merged.lastPlayed}`
    + `${merged.cover ? `, cover: ${merged.cover}` : ''}`,
  )
  return merged
}

async function main() {
  const config = readConfig()

  const sgdbApiKey = config.sgdbApiKey || process.env.STEAMGRIDDB_API_KEY || DEFAULT_SGDB_KEY

  // --list-covers "<名字>"：只列出 SteamGridDB 候选图，不写任何文件
  const listIndex = process.argv.indexOf('--list-covers')
  if (listIndex !== -1) {
    const title = process.argv[listIndex + 1]
    if (!title) {
      throw new Error('用法: --list-covers "<游戏名>"')
    }
    await listCovers(title, sgdbApiKey)
    return
  }

  // --check：只探测、只报告，不写文件
  if (process.argv.includes('--check')) {
    await checkSteam(config)
    return
  }

  const existingHistory = readExistingHistory()
  const vdfLines = readVdfFile(config.vdfPath)

  const configDir = path.dirname(config.vdfPath)
  const shortcutsPath = config.shortcutsPath ?? path.join(configDir, 'shortcuts.vdf')
  const gridPath = config.gridPath ?? path.join(configDir, 'grid')

  // fake-stock real appids: keyed by the plain appid in localconfig
  for (const appId of config.fakeAppIds) {
    const data = extractAppDataFromVdf(vdfLines, String(appId))
    if (data) {
      merge(existingHistory, String(appId), data, 'VDF')
    }
    else {
      console.log(`[VDF] AppID ${appId}: not found in VDF`)
    }
  }

  // non-Steam shortcuts: playtime lives under the signed appid, last played in shortcuts.vdf
  const shortcuts = parseShortcutsVdf(shortcutsPath)
  for (const shortcut of shortcuts) {
    const signed = toSignedAppId(shortcut.appId)
    const unsigned = extractAppDataFromVdf(vdfLines, String(shortcut.appId))
    const signedData = extractAppDataFromVdf(vdfLines, String(signed))

    const playtime = Math.max(unsigned?.playtime ?? 0, signedData?.playtime ?? 0)
    const lastPlayed = Math.max(
      unsigned?.lastPlayed ?? 0,
      signedData?.lastPlayed ?? 0,
      shortcut.lastPlayTime,
    )

    if (playtime === 0 && lastPlayed === 0) {
      console.log(`[Shortcut] ${shortcut.appId} ${shortcut.name}: no play data yet, skipped`)
      continue
    }

    const cover = await resolveCover(String(shortcut.appId), undefined, shortcut.name, gridPath, sgdbApiKey)
    merge(existingHistory, String(shortcut.appId), {
      playtime,
      lastPlayed,
      name: shortcut.name,
      ...(cover ? { cover } : {}),
      ...resolveLinks(String(shortcut.appId), config),
    }, 'Shortcut')

    if (!cover) {
      console.log(`  [Cover] ${shortcut.appId}: no artwork found in ${gridPath}`)
    }
  }

  // 手动补录：steam 里没有记录的老游戏，或想自己指定封面来源
  const nameZhCustom = readJson<Record<string, string>>(NAMEZH_CUSTOM_PATH, {})
  let nameZhUpdated = false

  for (const extra of config.extraGames) {
    const title = extra.name
    const key = extra.appId != null ? String(extra.appId) : (title ? String(stableAppId(title)) : '')

    if (!key) {
      console.warn('[Extra] entry needs an appId or a name, skipped')
      continue
    }
    if (extra.appId == null) {
      console.log(`[Extra] ${title}: generated appId ${key}`)
    }

    const cover = await resolveCover(key, extra.cover === 'grid' ? undefined : extra.cover, title, gridPath, sgdbApiKey)
    merge(existingHistory, key, {
      playtime: toMinutes(extra.playtime),
      lastPlayed: toTimestamp(extra.lastPlayed),
      ...(title ? { name: title } : {}),
      ...(cover ? { cover } : {}),
      ...resolveLinks(key, config, extra),
    }, 'Extra')

    if (extra.nameZh && nameZhCustom[key] !== extra.nameZh) {
      nameZhCustom[key] = extra.nameZh
      nameZhUpdated = true
    }
  }

  if (DRY_RUN) {
    console.log('\n--- dry run, nothing written ---')
    console.log(JSON.stringify(existingHistory, null, 2))
    return
  }

  await writeJsonFile(HISTORY_PATH, existingHistory)
  if (nameZhUpdated) {
    await writeJsonFile(NAMEZH_CUSTOM_PATH, nameZhCustom)
  }
  console.log(`\nSaved to ${HISTORY_PATH}`)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
