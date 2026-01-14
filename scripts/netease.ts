import crypto from 'node:crypto'
import process from 'node:process'
import axios from 'axios'
import { writeJsonFile } from '../utils'
import 'dotenv/config'

interface SongInfoItem {
  name: string
  artist: string
  album: string
  pic: string
  id: number
  url: string
  score?: number
}

function aesEncrypt(secKey: string, text: string) {
  const cipher = crypto.createCipheriv('AES-128-CBC', secKey, '0102030405060708')
  return cipher.update(text, 'utf-8', 'base64') + cipher.final('base64')
}

function aesRsaEncrypt(text: string) {
  return {
    params: aesEncrypt('TA3YiYCfY2dDJQgg', aesEncrypt('0CoJUm6Qyw8W8jud', text)),
    encSecKey:
      '84ca47bca10bad09a6b04c5c927ef077d9b9f1e37098aa3eac6ea70eb59df0aa28b691b7e75e4f1f9831754919ea784c8f74fbfadf2898b0be17849fd656060162857830e241aba44991601f137624094c114ea8d17bce815b0cd4e5b8e2fbaba978c6d1d14dc3d1faf852bdd28818031ccdaaa13a6018e1024e2aae98844210',
  }
}

async function fetchRecentPlayed(id: string): Promise<SongInfoItem[]> {
  const { data } = await axios.post(
    'https://music.163.com/weapi/v1/play/record?csrf_token=',
    aesRsaEncrypt(JSON.stringify({ uid: id, type: '1' })),
    {
      headers: {
        'Accept': '*/*',
        'Accept-Encoding': 'gzip,deflate,sdch',
        'Accept-Language': 'zh-CN,en-US;q=0.7,en;q=0.3',
        'Connection': 'keep-alive',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Host': 'music.163.com',
        'Referer': 'https://music.163.com/',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36',
      },
    },
  )
  const songs = data.weekData ?? []
  return songs.map(({ song, score }: { song: any, score: number }) => ({
    name: song.name,
    artist: song.ar.map(({ name }: { name: string }) => name).join('/'),
    album: song.al.name,
    pic: song.al.picUrl,
    id: song.id,
    url: `https://music.163.com/#/song?id=${song.id}`,
    score,
  }))
}

async function fetchFavorite(favoriteId: string): Promise<SongInfoItem[]> {
  try {
    const { data } = await axios.post(
      'https://music.163.com/api/v3/playlist/detail',
      `id=${favoriteId}&n=1000&s=8`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://music.163.com/',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36',
        },
      },
    )
    const favSongs = data.playlist.tracks
    return favSongs.map((song: any) => ({
      name: song.name,
      artist: song.ar.map(({ name }: { name: string }) => name).join('/'),
      album: song.al.name,
      pic: song.al.picUrl,
      id: song.id,
      url: `https://music.163.com/#/song?id=${song.id}`,
    }))
  }
  catch {
    return []
  }
}

async function main() {
  const id = process.env.NETEASE_ID
  const favoriteId = process.env.NETEASE_FAVORITE_ID

  if (!id && !favoriteId) {
    throw new Error('NETEASE_ID or NETEASE_FAVORITE_ID must be set')
  }

  const [recentPlayed, favorite] = await Promise.all([
    id ? fetchRecentPlayed(id) : Promise.resolve([]),
    favoriteId ? fetchFavorite(favoriteId) : Promise.resolve([]),
  ])

  // Write data to separate files in the new structure
  await writeJsonFile('data/netease/recentPlayed.json', recentPlayed)
  await writeJsonFile('data/netease/favorite.json', favorite)
  console.log('Saved to data/netease/ directory')
}

main().catch((err) => {
  console.error('Error occurred:', err)
  process.exit(1)
})
