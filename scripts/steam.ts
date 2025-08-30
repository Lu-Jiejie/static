import fs from 'node:fs'
import process from 'node:process'
import axios from 'axios'
import { load } from 'cheerio'
import { writeJsonFile } from '../utils'
import 'dotenv/config'

function readNameCNMap(): Record<string, string> {
  try {
    const raw = fs.readFileSync('./data/steam_namecn_map.json', 'utf-8')
    return JSON.parse(raw)
  }
  catch {
    return {}
  }
}

interface SteamInfo {
  user: {
    id: string
    name: string
    avatar: string
    createdTime: number
    lastLogOffTime: number
  }
  games: {
    id: string
    name: string
    nameCN: string
    playtimeForever: number
    playtime2Weeks: number
    timeLastPlayed: number
    icon: string
  }[]
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

async function fetchSteamTitle(appid: number): Promise<string | null> {
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
    return title.replace(/^Steam 上的 /, '')
  }
  catch {
    return null
  }
}

async function fetchOwnedGames(id: string, key: string, exclude: number[]): Promise<SteamInfo['games']> {
  const { data } = await axios.get(
    `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${key}&steamid=${id}&format=json&include_appinfo=true&include_played_free_games=true`,
  )

  const games = data.response.games.filter((game: any) => !exclude.includes(game.appid))
  const nameCNMap = readNameCNMap()
  let updated = false

  const results: SteamInfo['games'] = await Promise.all(
    games.map(async (game: any) => {
      const id = game.appid
      const iconHash = game.img_icon_url || game.img_logo_url
      const icon = iconHash
        ? `http://media.steampowered.com/steamcommunity/public/images/apps/${id}/${iconHash}.jpg`
        : undefined
      let nameCN = nameCNMap[id]
      if (!nameCN) {
        nameCN = (await fetchSteamTitle(id)) || game.name
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
  if (updated) {
    fs.writeFileSync('./data/steam_namecn_map.json', JSON.stringify(nameCNMap, null, 2), 'utf-8')
  }
  return results
}

async function main() {
  const steamId = process.env.STEAM_ID
  const steamKey = process.env.STEAM_KEY
  const steamGamesExclude = process.env.STEAM_GAMES_EXCLUDE.split(',').map(i => +i)

  if (!steamId || !steamKey) {
    throw new Error('STEAM_ID and STEAM_KEY must be set')
  }

  const [user, games] = await Promise.all([
    fetchUserInfo(steamId, steamKey),
    fetchOwnedGames(steamId, steamKey, steamGamesExclude),
  ])

  const steamInfo: SteamInfo = {
    user,
    games,
  }

  await writeJsonFile(`./data/steam.json`, steamInfo)
  console.log('Saved to data/steam.json')
}

main().catch((err) => {
  console.error('Error occurred:', err)
  process.exit(1)
})
