import process from 'node:process'
import axios from 'axios'
import { writeJsonFile } from '../utils'
import 'dotenv/config'
// https://bangumi.github.io/api/

interface AnimeItem {
  id: number
  date: string
  name: string
  name_cn: string
  summary: string
  tags: {
    name: string
    count: number
  }
  pic: string
  updated_at: string
}

interface BangumiInfo {
  watching: AnimeItem[]
  watched: AnimeItem[]
  toWatch: AnimeItem[]
}

async function fetchBangumiCollections(bangumiId: string, bangumiUserAgent: string):
Promise<Pick<BangumiInfo, 'watching' | 'toWatch' | 'watched'>> {
  const { data: { data } } = await axios.get<{ data: any }>(
    `https://api.bgm.tv/v0/users/${bangumiId}/collections?subject_type=2`,
    {
      headers: {
        'Accept': 'application/json',
        'User-Agent': bangumiUserAgent,
      },
    },
  )

  const animeMap = (animeItem: any): AnimeItem => {
    return {
      id: animeItem.subject_id,
      date: animeItem.subject.date,
      name: animeItem.subject.name,
      name_cn: animeItem.subject.name_cn,
      summary: animeItem.subject.short_summary,
      tags: animeItem.subject.tags.map((t: any) => ({ name: t.name, total: t.total })),
      pic: animeItem.subject.images.common,
      updated_at: animeItem.updated_at,
    }
  }

  const watching = data.filter((item: any) => item.type === 3).map(animeMap)
  const toWatch = data.filter((item: any) => item.type === 1).map(animeMap)
  const watched = data.filter((item: any) => item.type === 2).map(animeMap)

  return {
    watching,
    toWatch,
    watched,
  }
}

async function main() {
  const bangumiId = process.env.BANGUMI_ID
  // https://github.com/bangumi/api/blob/master/docs-raw/user%20agent.md
  const bangumiUserAgent = process.env.BANGUMI_USER_AGENT || 'lu-jiejie/static'

  if (!bangumiId) {
    throw new Error('BANGUMI_ID is not defined')
  }

  const { watching, toWatch, watched } = await fetchBangumiCollections(bangumiId, bangumiUserAgent)

  // Write data to separate files in the new structure
  await writeJsonFile(`./data/bangumi/watching.json`, watching)
  await writeJsonFile(`./data/bangumi/toWatch.json`, toWatch)
  await writeJsonFile(`./data/bangumi/watched.json`, watched)
}

main().catch((err) => {
  console.error('Error occurred:', err)
  process.exit(1)
})
