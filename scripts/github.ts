import fs from 'node:fs'
import process from 'node:process'
import axios from 'axios'
import axiosRetry from 'axios-retry'
import { writeJsonFile } from '../utils'
import 'dotenv/config'

axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay })

interface ContributionDay {
  date: string
  count: number
  level: number
}

interface LastYearContributions {
  total: number
  weeks: ContributionDay[][]
}

interface Repo {
  name: string
  full_name: string
}

interface LanguageInfo {
  bytes: number
  color: string
  percentage: number
}

interface GitHubInfo {
  languageDistribution: Record<string, LanguageInfo>
  lastYearContributions: LastYearContributions
  releases: ReleaseInfo[]
}

interface ReleaseInfo {
  id: string
  type: string
  repo: string
  isOrg: boolean
  title: string
  sha: string
  commit: string
  created_at: number
  version: string
}

const EXCLUDE_REPOS: string[] = []

function filterContributionsForLastYear(contributions: ContributionDay[]) {
  const sortedContributions = [...contributions].sort((a, b) => {
    return new Date(a.date).getTime() - new Date(b.date).getTime()
  })

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const startDay = new Date()
  startDay.setDate(today.getDate() - 370)
  startDay.setHours(0, 0, 0, 0)

  const filteredDays = sortedContributions.filter((day) => {
    const date = new Date(day.date)
    date.setHours(0, 0, 0, 0)
    return date >= startDay && date <= today
  })

  if (filteredDays.length > 0) {
    const lastDate = new Date(filteredDays[filteredDays.length - 1].date)
    lastDate.setHours(0, 0, 0, 0)

    if (lastDate.getTime() !== today.getTime()) {
      const todayFormatted = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      filteredDays.push({
        date: todayFormatted,
        count: 0,
        level: 0,
      })
    }
  }

  const sortedDays = [...filteredDays].sort((a, b) => {
    return new Date(a.date).getTime() - new Date(b.date).getTime()
  })
  return {
    filteredDays: sortedDays,
    today,
    startDay,
  }
}

function calculateWeeks(filteredDays: ContributionDay[]) {
  const weeksArray: ContributionDay[][] = []
  let week: ContributionDay[] = []

  filteredDays.forEach((day) => {
    week.push(day)
    if (week.length === 7) {
      weeksArray.push([...week])
      week = []
    }
  })
  if (week.length > 0) {
    weeksArray.push([...week])
  }
  return weeksArray
}

async function fetchLastYearContributions(username: string): Promise<LastYearContributions | null> {
  try {
    const response = await axios.get(`https://github-contributions-api.jogruber.de/v4/${username}`)
    const res = response.data.contributions as ContributionDay[]
    const { filteredDays } = filterContributionsForLastYear(res)
    const total = filteredDays.reduce((sum, day) => sum + day.count, 0)
    const weeksData = calculateWeeks(filteredDays)
    return {
      total,
      weeks: weeksData,
    }
  }
  catch (error) {
    console.error('Failed to fetch contributions:', error)
    return null
  }
}

async function fetchAllRepos(username: string, token: string) {
  const { data } = await axios.get<Repo[]>(
    `https://api.github.com/users/${username}/repos?type=owner&per_page=100&sort=updated&direction=desc`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    },
  )

  return data.filter((repo: any) => !repo.fork && !EXCLUDE_REPOS.includes(repo.name))
}

async function fetchLanguageColors(): Promise<Record<string, string>> {
  const url = 'https://raw.githubusercontent.com/ozh/github-colors/master/colors.json'
  const { data } = await axios.get(url)
  const colorMap: Record<string, string> = {}
  Object.entries(data).forEach(([lang, info]: [string, any]) => {
    colorMap[lang] = info.color || '#000000'
  })
  return colorMap
}

async function fetchLanguageDistribution(repos: Repo[], token: string): Promise<GitHubInfo['languageDistribution']> {
  const languageDistribution: Record<string, LanguageInfo> = {}
  const colorMap = await fetchLanguageColors()

  await Promise.all(
    repos.map(async (repo) => {
      const { data } = await axios.get(
        `https://api.github.com/repos/${repo.full_name}/languages`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
          },
        },
      )
      Object.entries(data).forEach(([language, bytes]) => {
        if (!languageDistribution[language]) {
          languageDistribution[language] = {
            bytes: 0,
            color: colorMap[language] || '#000000',
            percentage: 0,
          }
        }
        languageDistribution[language].bytes += Number(bytes)
      })
    }),
  )
  // percentage
  const totalBytes = Object.values(languageDistribution).reduce((sum, info) => sum + info.bytes, 0)
  Object.values(languageDistribution).forEach((info) => {
    info.percentage = totalBytes > 0 ? (info.bytes / totalBytes) * 100 : 0
  })
  return languageDistribution
}

// Inspired by: https://github.com/antfu/releases.antfu.me
async function fetchReleases(username: string, token: string): Promise<ReleaseInfo[]> {
  const infos: ReleaseInfo[] = []

  try {
    console.log('Fetching releases from GitHub Releases API...')

    const reposResponse = await axios.get(
      `https://api.github.com/users/${username}/repos?type=owner&per_page=100`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      },
    )

    const repos = reposResponse.data.filter((repo: any) => !repo.fork)
    console.log(`Checking ${repos.length} repositories for releases...`)

    for (const repo of repos) {
      try {
        const releasesResponse = await axios.get(
          `https://api.github.com/repos/${repo.full_name}/releases`,
          {
            headers: {
              Authorization: `token ${token}`,
              Accept: 'application/vnd.github.v3+json',
            },
          },
        )

        console.log(`  ${repo.name}: found ${releasesResponse.data.length} releases`)

        for (const release of releasesResponse.data) {
          const versionMatch = release.tag_name.match(/v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/)
          if (versionMatch) {
            const version = versionMatch[1]
            const releaseInfo: ReleaseInfo = {
              id: release.id.toString(),
              type: 'ReleaseEvent',
              repo: repo.name,
              isOrg: repo.organization !== null,
              title: release.name || release.tag_name,
              sha: release.target_commitish || '',
              commit: `https://github.com/${repo.full_name}/releases/tag/${release.tag_name}`,
              created_at: +new Date(release.published_at || release.created_at),
              version,
            }

            infos.push(releaseInfo)
          }
        }
      }
      catch {
        console.log(`  ${repo.name}: no releases or access error`)
      }
    }

    // Remove duplicates and sort completely by date (newest to oldest)
    const uniqueReleases = infos.filter((release, index) => {
      const first = infos.findIndex(r =>
        r.repo === release.repo
        && r.version === release.version
        && r.sha === release.sha,
      )
      return first === index
    })

    const finalReleases = uniqueReleases
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 500) // Limit to latest 500 releases

    console.log(`Final releases count: ${finalReleases.length}`)

    const repoCount = finalReleases.reduce((acc, release) => {
      acc[release.repo] = (acc[release.repo] || 0) + 1
      return acc
    }, {} as Record<string, number>)

    console.log('Release summary:')
    Object.entries(repoCount)
      .sort(([,a], [,b]) => b - a)
      .forEach(([repo, count]) => {
        console.log(`  ${repo}: ${count} releases`)
      })

    return finalReleases
  }
  catch (error) {
    console.error('Failed to fetch releases:', error)
    return []
  }
}

async function main() {
  const githubToken = process.env.GITHUB_TOKEN
  const username = process.env.GITHUB_USERNAME

  if (!githubToken || !username) {
    throw new Error('GITHUB_TOKEN and GITHUB_USERNAME must be set')
  }

  const repos = await fetchAllRepos(username, githubToken)
  const languageDistribution = await fetchLanguageDistribution(repos, githubToken)
  const releases = await fetchReleases(username, githubToken)

  let lastYearContributions = await fetchLastYearContributions(username)

  if (!lastYearContributions) {
    try {
      // Try to read from new structure first, fallback to old structure
      let raw: string
      try {
        raw = fs.readFileSync('data/github/lastYearContributions.json', 'utf-8')
        lastYearContributions = JSON.parse(raw)
      }
      catch {
        // Fallback to old structure
        raw = fs.readFileSync('data/github.json', 'utf-8')
        const preJson = JSON.parse(raw)
        lastYearContributions = preJson.lastYearContributions
      }
      console.warn('Using cached lastYearContributions from previous data')
    }
    catch {
      lastYearContributions = null
    }
  }

  // Write data to separate files in the new structure
  await writeJsonFile('data/github/languageDistribution.json', languageDistribution)
  await writeJsonFile('data/github/releases.json', releases)
  if (lastYearContributions) {
    await writeJsonFile('data/github/lastYearContributions.json', lastYearContributions)
  }
}

main().catch((err) => {
  console.error('Error occurred:', err)
  process.exit(1)
})
