import process from 'node:process'
import axios from 'axios'
import { downloadImage, writeJsonFile } from '../utils'
import 'dotenv/config'

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
    playtimeForever: number
    playtime2Weeks: number
    icon: string
  }[]
}

async function fetchUserInfo(id: string, key: string): Promise<SteamInfo['user']> {
  const { data } = await axios.get(
    `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${id}&format=json`,
  )

  const player = data.response.players[0]
  const avatar = player.avatarfull
  // await downloadImage(avatar, `./data/steam/avatar.jpg`, true)
  return {
    id: player.steamid,
    name: player.personaname,
    avatar,
    createdTime: player.timecreated,
    lastLogOffTime: player.lastlogoff,
  }
}

async function fetchOwnedGames(id: string, key: string): Promise<SteamInfo['games']> {
  const { data } = await axios.get(
    `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${key}&steamid=${id}&format=json&include_appinfo=true&include_played_free_games=true`,
  )

  return data.response.games.map((game: any) => {
    const id = game.appid
    const iconHash = game.img_icon_url || game.img_logo_url
    const icon = iconHash
      ? `http://media.steampowered.com/steamcommunity/public/images/apps/${id}/${iconHash}.jpg`
      : undefined
    return {
      id,
      name: game.name,
      playtimeForever: game.playtime_forever,
      playtime2Weeks: game.playtime_2weeks,
      icon,
    }
  })
}

async function main() {
  const steamId = process.env.STEAM_ID
  const steamKey = process.env.STEAM_KEY

  if (!steamId || !steamKey) {
    throw new Error('STEAM_ID and STEAM_KEY must be set')
  }

  const [user, games] = await Promise.all([
    fetchUserInfo(steamId, steamKey),
    fetchOwnedGames(steamId, steamKey),
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
