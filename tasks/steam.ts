import fs from 'node:fs'
import process from 'node:process'
import axios from 'axios'
import { load } from 'cheerio'
import { writeJsonFile } from '../utils'
import 'dotenv/config'

function readNameCNMapCustom(): Record<string, string> {
  try {
    const raw = fs.readFileSync('./data/steam/namecn_map_custom.json', 'utf-8')
    return JSON.parse(raw)
  }
  catch {
    return {}
  }
}

function readNameCNMap(): Record<string, string> {
  try {
    let raw: string
    try {
      raw = fs.readFileSync('./data/steam/namecn_map.json', 'utf-8')
    }
    catch {
      raw = fs.readFileSync('./data/steam_namecn_map.json', 'utf-8')
    }
    return JSON.parse(raw)
  }
  catch {
    return {}
  }
}

interface LocalHistoryEntry {
  playtime: number
  lastPlayed: number
}

function readLocalHistory(): Record<string, LocalHistoryEntry> {
  try {
    const raw = fs.readFileSync('./data/steam/games_local.json', 'utf-8')
    return JSON.parse(raw)
  }
  catch {
    return {}
  }
}

interface GameItem {
  id: number
  name: string
  nameCN: string
  playtimeForever: number
  playtime2Weeks?: number
  timeLastPlayed: number
  icon: string
}

interface SteamInfo {
  user: {
    id: string
    name: string
    avatar: string
    createdTime: number
    lastLogOffTime: number
  }
  games: GameItem[]
}

async function fetchUserInfo(id: string, key: string): Promise<SteamInfo['user']> {
  const { data } = await axios.get(
    `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${id}&format=json`,
  )

  const player = data.response.players[0]
  const avatar = player.avatarfull
  return {
    id: player.steamid,
    name: player.personaname,
    avatar,
    createdTime: player.timecreated,
    lastLogOffTime: player.lastlogoff,
  }
}

async function fetchSteamTitleCN(appid: number): Promise<string | null> {
  try {
    const url = `https://store.steampowered.com/app/${appid}`
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    })
    const $ = load(html)
    const name = $('#appHubAppName').text().trim()
    if (name) {
      return name
    }

    const title = $('title').text().trim()
    // exclude 在 Steam 上购买
    if (/在 Steam 上购买/.test(title)) {
      return null
    }
    return title.replace(/^Steam 上的 /, '')
  }
  catch {
    return null
  }
}

const STORE_ASSET_BASE = 'https://shared.akamai.steamstatic.com/store_item_assets'

// 新上架游戏的封面迁到了带 hash 的路径（steam/apps/{id}/{hash}/header.jpg），
// 旧的 steam/apps/{id}/header.jpg 对它们一律 404，所以向 StoreBrowse 查真实文件名。
async function fetchStoreHeaders(appIds: number[]): Promise<Record<number, string>> {
  const covers: Record<number, string> = {}
  const chunkSize = 100

  for (let i = 0; i < appIds.length; i += chunkSize) {
    const ids = appIds.slice(i, i + chunkSize).map(appid => ({ appid }))
    const input = JSON.stringify({
      ids,
      context: { language: 'schinese', country_code: 'CN' },
      data_request: { include_assets: true },
    })

    try {
      const { data } = await axios.get(
        `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(input)}`,
      )

      for (const item of data?.response?.store_items ?? []) {
        const assets = item.assets
        if (!assets?.header || !assets?.asset_url_format)
          continue
        covers[item.appid] = `${STORE_ASSET_BASE}/${assets.asset_url_format.replace('${FILENAME}', assets.header)}`
      }
    }
    catch (err) {
      console.warn(`  [Cover] StoreBrowse failed for batch ${i / chunkSize}:`, (err as Error).message)
    }
  }

  return covers
}

// StoreBrowse 查不到的（下架 / 无商店页）退回旧路径，多数老游戏仍然有效
function legacyCover(appId: number) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`
}

async function fetchOwnedGames(id: string, key: string, exclude: number[]): Promise<GameItem[]> {
  const { data } = await axios.get(
    `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${key}&steamid=${id}&format=json&include_appinfo=true&include_played_free_games=true`,
  )

  const apiGames = data.response.games.filter((game: any) => !exclude.includes(game.appid))
  const apiGameIds = new Set<number>(apiGames.map((g: any) => g.appid))

  const localHistory = readLocalHistory()
  const localAppIds = Object.keys(localHistory)
    .map(Number)
    .filter(appId => !apiGameIds.has(appId))

  const covers = await fetchStoreHeaders([...apiGameIds, ...localAppIds])

  const nameCNMapCustom = readNameCNMapCustom()
  const nameCNMap = readNameCNMap()
  let updated = false

  const results: GameItem[] = await Promise.all(
    apiGames.map(async (game: any) => {
      const id = game.appid
      let nameCN = nameCNMapCustom[id]
      if (!nameCN) {
        nameCN = nameCNMap[id]
      }
      if (!nameCN) {
        nameCN = (await fetchSteamTitleCN(id)) || game.name
        nameCNMap[id] = nameCN
        updated = true
      }
      return {
        id,
        name: game.name,
        nameCN,
        playtimeForever: game.playtime_forever,
        playtime2Weeks: game.playtime_2weeks,
        timeLastPlayed: game.rtime_last_played,
        icon: covers[id] ?? legacyCover(id),
      }
    }),
  )

  // Merge local history games (from scripts/steam-local-sync.ts)
  const localEntries: GameItem[] = []

  for (const appId of localAppIds) {
    const entry = localHistory[appId]

    // Resolve name for local-only game
    let nameCN = nameCNMapCustom[appId]
    if (!nameCN) {
      nameCN = nameCNMap[appId]
    }
    let name = nameCN || ''
    if (!name) {
      const title = await fetchSteamTitleCN(appId)
      if (title) {
        name = title
        nameCN = title
      }
      else {
        name = `Unknown Game (${appId})`
        nameCN = name
      }
      nameCNMap[appId] = nameCN
      updated = true
    }

    localEntries.push({
      id: appId,
      name,
      nameCN,
      playtimeForever: entry.playtime,
      timeLastPlayed: entry.lastPlayed,
      icon: covers[appId] ?? legacyCover(appId),
    })
    console.log(`  [LocalHistory] AppID ${appId}: merged (${nameCN})`)
  }

  if (updated) {
    fs.writeFileSync('./data/steam/namecn_map.json', JSON.stringify(nameCNMap, null, 2), 'utf-8')
  }

  // API results first, then local entries
  return [...results, ...localEntries]
}

async function main() {
  const steamId = process.env.STEAM_ID
  const steamKey = process.env.STEAM_KEY
  const steamGamesExclude = (process.env.STEAM_GAMES_EXCLUDE || '').split(',').filter(Boolean).map(i => +i)

  if (!steamId || !steamKey) {
    throw new Error('STEAM_ID and STEAM_KEY must be set')
  }

  const [user, games] = await Promise.all([
    fetchUserInfo(steamId, steamKey),
    fetchOwnedGames(steamId, steamKey, steamGamesExclude),
  ])

  // Write data to separate files in the new structure
  await writeJsonFile(`./data/steam/user.json`, user)
  await writeJsonFile(`./data/steam/games.json`, games)
  console.log('Saved to data/steam/directory')
}

main().catch((err) => {
  console.error('Error occurred:', err)
  process.exit(1)
})
