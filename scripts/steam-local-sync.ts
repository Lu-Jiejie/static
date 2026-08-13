import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeJsonFile } from '../utils'

interface LocalHistoryEntry {
  playtime: number
  lastPlayed: number
}

interface LocalHistoryData {
  [appId: string]: LocalHistoryEntry
}

interface ExtraGameConfig {
  appId: string
  playtime: number
  lastPlayed: number
}

interface LocalSyncConfig {
  vdfPath: string
  fakeAppIds: number[]
  extraGames: ExtraGameConfig[]
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, './config.json')

function readConfig(): LocalSyncConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw)
  }
  catch {
    throw new Error(
      `Missing config file: ${CONFIG_PATH}\n`
      + 'Create it with your Steam local config.',
    )
  }
}

function readVdfFile(vdfPath: string): string[] {
  return fs.readFileSync(vdfPath, 'utf-8').split('\n')
}

function extractAppDataFromVdf(lines: string[], appId: string): { playtime: number, lastPlayed: number } | null {
  let playtime = 0
  let lastPlayed = 0
  let inTargetApp = false
  let bracketCount = 0

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === `"${appId}"`) {
      inTargetApp = true
      bracketCount = 0
      continue
    }

    if (inTargetApp) {
      if (trimmed.includes('{')) bracketCount++
      if (trimmed.includes('}')) bracketCount--

      const playtimeMatch = trimmed.match(/"Playtime"\s*"(\d+)"/)
      if (playtimeMatch) playtime = Number(playtimeMatch[1])

      const lastPlayedMatch = trimmed.match(/"LastPlayed"\s*"(\d+)"/)
      if (lastPlayedMatch) lastPlayed = Number(lastPlayedMatch[1])

      if (bracketCount === 0 && trimmed === '}') {
        break
      }
    }
  }

  if (playtime > 0 || lastPlayed > 0) {
    return { playtime, lastPlayed }
  }
  return null
}

function readExistingHistory(): LocalHistoryData {
  try {
    const raw = fs.readFileSync('./data/steam/games_local.json', 'utf-8')
    return JSON.parse(raw)
  }
  catch {
    return {}
  }
}

async function main() {
  const config = readConfig()
  const existingHistory = readExistingHistory()
  const vdfLines = readVdfFile(config.vdfPath)

  // Process fake app IDs from Steam VDF
  for (const appId of config.fakeAppIds) {
    const data = extractAppDataFromVdf(vdfLines, String(appId))
    if (data) {
      const old = existingHistory[appId]
      existingHistory[appId] = {
        playtime: Math.max(old?.playtime ?? 0, data.playtime),
        lastPlayed: Math.max(old?.lastPlayed ?? 0, data.lastPlayed),
      }
      console.log(`[VDF] AppID ${appId}: ${existingHistory[appId].playtime}min, last: ${existingHistory[appId].lastPlayed}`)
    }
    else {
      console.log(`[VDF] AppID ${appId}: not found in VDF`)
    }
  }

  // Process extra manually configured games
  for (const extra of config.extraGames) {
    const old = existingHistory[extra.appId]
    existingHistory[extra.appId] = {
      playtime: Math.max(old?.playtime ?? 0, extra.playtime),
      lastPlayed: Math.max(old?.lastPlayed ?? 0, extra.lastPlayed),
    }
    console.log(`[Extra] AppID ${extra.appId}: ${existingHistory[extra.appId].playtime}min, last: ${existingHistory[extra.appId].lastPlayed}`)
  }

  writeJsonFile('./data/steam/games_local.json', existingHistory)
  console.log('Saved to data/steam/games_local.json')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})