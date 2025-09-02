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

async function main() {
  const githubToken = process.env.GITHUB_TOKEN
  const username = process.env.GITHUB_USERNAME

  if (!githubToken || !username) {
    throw new Error('GITHUB_TOKEN and GITHUB_USERNAME must be set')
  }

  const repos = await fetchAllRepos(username, githubToken)
  const languageDistribution = await fetchLanguageDistribution(repos, githubToken)

  let lastYearContributions = await fetchLastYearContributions(username)

  if (!lastYearContributions) {
    try {
      const raw = fs.readFileSync('data/github.json', 'utf-8')
      const preJson = JSON.parse(raw)
      lastYearContributions = preJson.lastYearContributions
      console.warn('Using cached lastYearContributions from previous github.json')
    }
    catch {
      lastYearContributions = null
    }
  }

  await writeJsonFile('data/github.json', {
    languageDistribution,
    lastYearContributions,
  })
}

main().catch((err) => {
  console.error('Error occurred:', err)
  process.exit(1)
})
