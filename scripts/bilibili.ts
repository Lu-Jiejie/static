import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import axios from 'axios'
import { downloadImage, writeJsonFile } from '../utils'

interface BilibiliResponse {
  code: number
  message: string
  ttl: number
  data: {
    info: any
    medias: Array<{
      id: number
      type: number
      title: string
      cover: string
      intro: string
      page: number
      duration: number
      upper: {
        mid: number
        name: string
        face: string
        jump_link: string
      }
      attr: number
      cnt_info: {
        collect: number
        play: number
        danmaku: number
        vt: number
        play_switch: number
        reply: number
        view_text_1: string
      }
      link: string
      ctime: number
      pubtime: number
      fav_time: number
      bv_id: string
      bvid: string
      season: any
      ogv: any
      ugc: {
        first_cid: number
      }
      media_list_link: string
    }>
    has_more: boolean
    ttl: number
  }
}

async function fetchBilibiliMusicLiked() {
  try {
    const url = 'https://api.bilibili.com/x/v3/fav/resource/list'
    const params = {
      media_id: '3666821184',
      ps: '6',
      platform: 'web',
    }

    const response = await axios.get<BilibiliResponse>(url, { params })

    if (response.data.code !== 0) {
      throw new Error(`API Error: ${response.data.message}`)
    }

    const { medias } = response.data.data
    console.log(`Fetched ${medias.length} favorite music items from Bilibili`)

    const formattedMedias = medias.map(item => ({
      title: item.title,
      cover: item.cover,
      intro: item.intro,
      id: item.id,
      bvid: item.bvid,
      link: `https://www.bilibili.com/video/${item.bvid}`,
      duration: item.duration,
      stats: item.cnt_info,
    }))

    return formattedMedias
  }
  catch (error) {
    console.error('Failed to fetch Bilibili music liked:', error)
    throw error
  }
}

async function main() {
  console.log('Fetching Bilibili favorite music...')
  const musicLiked = await fetchBilibiliMusicLiked()

  // Clear and recreate the images directory
  const imagesDir = './data/bilibili'
  try {
    await fs.rm(imagesDir, { recursive: true, force: true })
  }
  catch {
    // Directory might not exist, which is fine
  }
  await fs.mkdir(imagesDir, { recursive: true })

  // Download cover images
  console.log('Downloading cover images...')
  const downloadPromises = musicLiked.map(async (item) => {
    const imagePath = path.join(imagesDir, `${item.bvid}.jpg`)
    await downloadImage(item.cover, imagePath)
    console.log(`Downloaded cover for ${item.bvid}`)
  })

  await Promise.all(downloadPromises)
  await writeJsonFile('./data/bilibili.json', { musicLiked })
  console.log('Bilibili data and images updated successfully')
}

main().catch((err) => {
  console.error('Error occurred:', err)
  process.exit(1)
})
