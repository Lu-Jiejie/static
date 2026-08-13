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

async function fetchOwnedGames(id: string, key: string, exclude: number[]): Promise<GameItem[]> {
  const { data } = await axios.get(
    `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${key}&steamid=${id}&format=json&include_appinfo=true&include_played_free_games=true`,
  )

  const apiGames = data.response.games.filter((game: any) => !exclude.includes(game.appid))
  const apiGameIds = new Set(apiGames.map((g: any) => g.appid))

  const nameCNMapCustom = readNameCNMapCustom()
  const nameCNMap = readNameCNMap()
  let updated = false

  const results: GameItem[] = await Promise.all(
    apiGames.map(async (game: any) => {
      const id = game.appid
      const icon = `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`
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
        icon,
      }
    }),
  )

  // Merge local history games (from scripts/steam-local-sync.ts)
  const localHistory = readLocalHistory()
  const localEntries: GameItem[] = []

  for (const [appIdStr, entry] of Object.entries(localHistory)) {
    const appId = Number(appIdStr)
    if (apiGameIds.has(appId)) {
      // Already in API results, skip
      console.log(`  [LocalHistory] AppID ${appId}: skipped (already in API)`)
      continue
    }

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
      icon: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
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
