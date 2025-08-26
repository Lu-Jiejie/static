import process from 'node:process'
import axios from 'axios'
import { writeJsonFile } from '../utils'
import 'dotenv/config'

const EXCLUDE_REPOS: string[] = []

interface Repo {
  name: string
  full_name: string
}

interface GitHubInfo {
  languageStatus: Record<string, number>
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

async function fetchLanguageStatus(repos: Repo[], token: string): Promise<GitHubInfo['languageStatus']> {
  const languageStatus: Record<string, number> = {}

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
        languageStatus[language] = (languageStatus[language] || 0) + Number(bytes)
      })
    }),
  )
  return languageStatus
}

async function main() {
  const githubToken = process.env.GITHUB_TOKEN
  const username = process.env.GITHUB_USERNAME

  if (!githubToken || !username) {
    throw new Error('GITHUB_TOKEN and GITHUB_USERNAME must be set')
  }

  const repos = await fetchAllRepos(username, githubToken)
  const languageStatus = await fetchLanguageStatus(repos, githubToken)
  await writeJsonFile('data/github.json', { languageStatus })
}

main().catch((err) => {
  console.error('Error occurred:', err)
  process.exit(1)
})
