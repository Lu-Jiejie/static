import axios from 'axios'
import { load } from 'cheerio'

async function fetchSteamTitle(appid: number): Promise<string | null> {
  try {
    const url = `https://store.steampowered.com/app/${appid}`
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    })
    // console.log(html)
    const $ = load(html)
    const name = $('#appHubAppName').text().trim()
    if (name) {
      return name
    }

    const title = $('title').text().trim()
    return title.replace(/^Steam 上的 /, '')
  }
  catch (err) {
    console.error('Error fetching title:', err)
    return null
  }
}

// 示例：Cyberpunk 2077
// 1222140 1746030
fetchSteamTitle(1222140).then((title) => {
  console.log('Title:', title)
})
