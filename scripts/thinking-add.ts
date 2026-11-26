import fs from 'node:fs'
import process from 'node:process'
import prompts from 'prompts'
import { mergeThinking, monthPathFor, normalizeTimestamp, readMonth, writeMonth } from './thinking-merge'
import type { ThinkingEntry, ThinkingRef, ThinkingRefType } from './thinking-merge'
import { saveCover, saveDoubanFavicon } from './thinking-covers'
import { resolveRefMeta } from './thinking-meta'

const REF_TYPES: ThinkingRefType[] = ['watched', 'reading', 'quote', 'link', 'music', 'repo']

interface Options {
  text?: string
  ref?: string
  type?: ThinkingRefType
  title?: string
  subtitle?: string
  description?: string
  cover?: string
  quote?: string
  time?: string
  fromFile?: string
  dryRun: boolean
  interactive?: boolean
}

const HELP = `用法：
  pnpm thinking:add
  pnpm thinking:add "今天想说的话"
  pnpm thinking:add "看了，挺好" --ref https://www.bilibili.com/video/BV1xx411c7mD
  pnpm thinking:add --ref https://movie.douban.com/subject/1291561/ --text "第一次看的时候没看懂"
  pnpm thinking:add --ref https://book.douban.com/subject/1084336/ --text "补读"
  pnpm thinking:add "读到一句话" --type quote --quote "人不能两次踏进同一条河流"
  pnpm thinking:add --from-file notes.md
  pnpm thinking:add "补一条" --time "2026-11-01 21:30"

参数：
  -t, --text <text>          正文，也可以直接当位置参数写在最后
  -r, --ref <url>            引用链接，会自动抓标题/封面/简介
      --type <type>          watched | reading | quote | link | music | repo（默认按站点猜）
      --title <text>         覆盖抓到的标题
      --subtitle <text>      覆盖抓到的副标题
      --description <text>   覆盖抓到的一句话简介
      --cover <url>          覆盖抓到的封面
      --quote <text>         引用的一段话（type=quote 时用）
  -d, --time <time>          指定时间（默认现在），如 "2026-11-01 21:30"
  -f, --from-file <path>     批量导入，用单独一行 --- 分隔条目
      --dry-run              只打印结果，不写文件
  -i, --interactive          一条一条地问着写（不带参数直接运行也会进这个模式）
  -h, --help                 显示这段帮助`

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined)
        throw new Error(`${arg} 缺少值`)
      return value
    }
    switch (arg) {
      case '-h':
      case '--help':
        console.log(HELP)
        process.exit(0)
        break
      case '-t':
      case '--text':
        options.text = next()
        break
      case '-r':
      case '--ref':
      case '--link':
        options.ref = next()
        break
      case '--type':
        options.type = next() as ThinkingRefType
        if (!REF_TYPES.includes(options.type))
          throw new Error(`--type 只能是 ${REF_TYPES.join(' | ')}`)
        break
      case '--title':
        options.title = next()
        break
      case '--subtitle':
        options.subtitle = next()
        break
      case '--description':
        options.description = next()
        break
      case '--cover':
        options.cover = next()
        break
      case '--quote':
        options.quote = next()
        break
      case '-d':
      case '--time':
        options.time = next()
        break
      case '-f':
      case '--from-file':
        options.fromFile = next()
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '-i':
      case '--interactive':
        options.interactive = true
        break
      default:
        if (arg.startsWith('-'))
          throw new Error(`未知参数 ${arg}`)
        positional.push(arg)
    }
  }

  if (!options.text && positional.length)
    options.text = positional.join(' ')
  return options
}

async function buildEntry(options: Options, timestamp: string, preResolved?: ThinkingRef): Promise<ThinkingEntry> {
  const entry: ThinkingEntry = { timestamp: normalizeTimestamp(timestamp) }

  const text = options.text?.trim()
  if (text)
    entry.text = text

  if (options.ref?.trim()) {
    const url = options.ref.trim()
    const resolved: ThinkingRef = preResolved ?? await resolveRefMeta(url, options.type)
    entry.ref = {
      type: options.type ?? resolved.type,
      url,
      ...pick({
        title: options.title ?? resolved.title,
        subtitle: options.subtitle ?? resolved.subtitle,
        description: options.description ?? resolved.description,
        cover: options.cover ?? resolved.cover,
        quote: options.quote,
      }),
      ...(resolved.rating !== undefined ? { rating: resolved.rating } : {}),
      ...(resolved.stars !== undefined ? { stars: resolved.stars } : {}),
    }
    if (entry.ref.quote && entry.ref.type !== 'quote')
      entry.ref.type = 'quote'
    // 豆瓣的图（封面和图标）在博客里会被防盗链挡掉，存进仓库；别的站继续用外链
    if (!options.dryRun && /(?:^|\.)douban\.com/.test(entry.ref.url)) {
      await saveDoubanFavicon()
      if (entry.ref.cover)
        entry.ref.cover = await saveCover(entry.ref.cover, entry.timestamp)
    }
  }

  if (!entry.text && !entry.ref)
    throw new Error('这条是空的：至少给一段文本或一个链接')
  return entry
}

function pick(input: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => typeof value === 'string' && value.trim() !== ''),
  ) as Record<string, string>
}

async function appendEntry(entry: ThinkingEntry, dryRun: boolean) {
  const file = monthPathFor(entry.timestamp)
  const existing = readMonth(file)
  let { timestamp } = entry
  while (existing.some(item => item.timestamp === timestamp))
    timestamp = normalizeTimestamp(new Date(new Date(timestamp).getTime() + 1))
  const next = { ...entry, timestamp }

  if (dryRun) {
    console.log(`[dry-run] ${file}`)
    console.log(JSON.stringify(next, null, 2))
    return next
  }

  await writeMonth(file, [...existing, next])
  console.log(`[thinking] appended ${next.timestamp} → ${file}`)
  return next
}

function parseBatch(content: string): Options[] {
  const blocks = content
    .split(/^\s*---\s*$/m)
    .map(block => block.trim())
    .filter(Boolean)

  return blocks.map((block) => {
    const options: Options = { dryRun: false }
    const lines = block.split(/\r?\n/)
    const body: string[] = []
    let inBody = false

    for (const line of lines) {
      if (!inBody) {
        const match = line.match(/^(time|timestamp|ref|link|type|title|subtitle|description|cover|quote)\s*[:：]\s*(.+)$/i)
        if (match) {
          const key = match[1].toLowerCase()
          const value = match[2].trim()
          if (key === 'time' || key === 'timestamp')
            options.time = value
          else if (key === 'ref' || key === 'link')
            options.ref = value
          else if (key === 'type')
            options.type = value as ThinkingRefType
          else if (key === 'title')
            options.title = value
          else if (key === 'subtitle')
            options.subtitle = value
          else if (key === 'description')
            options.description = value
          else if (key === 'cover')
            options.cover = value
          else if (key === 'quote')
            options.quote = value
          continue
        }
        if (line.trim() === '')
          continue
        inBody = true
      }
      body.push(line)
    }

    const text = body.join('\n').trim()
    if (text)
      options.text = text
    return options
  })
}

const TYPE_LABELS: Record<ThinkingRefType, string> = {
  watched: '影视 / 动画',
  reading: '在读的书',
  quote: '引用一段话',
  link: '普通链接',
  music: '音乐',
  repo: '代码仓库',
}

function printPreview(ref: ThinkingRef) {
  const rows: Array<[string, string | undefined]> = [
    ['标题', ref.title],
    ['副标题', ref.subtitle],
    ['评分', ref.rating !== undefined ? String(ref.rating) : undefined],
    ['星数', ref.stars !== undefined ? String(ref.stars) : undefined],
    ['简介', ref.description],
  ]
  const filled = rows.filter(([, value]) => !!value)
  if (!filled.length)
    return
  console.log('\n抓到了：')
  for (const [label, value] of filled)
    console.log(`  ${label}：${value}`)
}

async function interactive(): Promise<{ options: Options, resolved?: ThinkingRef } | null> {
  let cancelled = false
  const ask = async (question: prompts.PromptObject) => {
    const answer = await prompts(question, {
      onCancel: () => {
        cancelled = true
      },
    })
    return cancelled ? null : answer
  }

  console.log('写一条随想（Ctrl+C 取消）\n')

  const lines: string[] = []
  for (;;) {
    const answer = await ask({
      type: 'text',
      name: 'line',
      message: lines.length ? '还有一行？空着结束' : '要说的话（可空）',
    })
    if (!answer)
      return null
    const line = String(answer.line ?? '')
    if (!line.trim())
      break
    lines.push(line)
  }

  const refAnswer = await ask({ type: 'text', name: 'ref', message: '引用链接（可空）' })
  if (!refAnswer)
    return null
  const ref = String(refAnswer.ref ?? '').trim()

  const options: Options = { dryRun: false }
  const text = lines.join('\n').trim()
  if (text)
    options.text = text
  if (!ref)
    return text ? { options } : null
  options.ref = ref

  console.log('\n抓取中…')
  let resolved: ThinkingRef
  try {
    resolved = await resolveRefMeta(ref)
  }
  catch (error) {
    console.warn(`  抓取失败：${(error as Error).message}`)
    resolved = { type: 'link', url: ref }
  }
  printPreview(resolved)

  const fallback = resolved.type ?? 'link'
  const typeAnswer = await ask({
    type: 'select',
    name: 'type',
    message: '类型',
    choices: REF_TYPES.map(type => ({ title: `${TYPE_LABELS[type]}（${type}）`, value: type })),
    initial: Math.max(REF_TYPES.indexOf(fallback), 0),
  })
  if (!typeAnswer)
    return null
  if (typeAnswer.type && typeAnswer.type !== fallback)
    options.type = typeAnswer.type as ThinkingRefType

  if ((options.type ?? fallback) === 'quote') {
    const quoteAnswer = await ask({ type: 'text', name: 'quote', message: '引用的一句话' })
    if (!quoteAnswer)
      return null
    const quote = String(quoteAnswer.quote ?? '').trim()
    if (quote)
      options.quote = quote
  }

  const timeAnswer = await ask({ type: 'text', name: 'time', message: '时间（回车用现在，如 2026-11-01 21:30）' })
  if (!timeAnswer)
    return null
  const time = String(timeAnswer.time ?? '').trim()
  if (time)
    options.time = time

  return { options, resolved }
}

async function main() {
  const argv = process.argv.slice(2)
  const wantsInteractive = argv.length === 0 || argv.includes('-i') || argv.includes('--interactive')

  if (wantsInteractive) {
    if (!process.stdin.isTTY) {
      console.log(HELP)
      return
    }
    const result = await interactive()
    if (!result) {
      console.log('什么都没写，放弃了。')
      return
    }
    const { options: answers, resolved } = result
    const entry = await buildEntry(answers, answers.time ?? new Date().toISOString(), resolved)
    console.log()
    await appendEntry(entry, false)
    await mergeThinking()
    return
  }

  const options = parseArgs(argv)

  if (options.fromFile) {
    const content = fs.readFileSync(options.fromFile, 'utf-8')
    const items = parseBatch(content)
    if (!items.length)
      throw new Error(`${options.fromFile} 里没有可导入的条目`)
    console.log(`[thinking] ${items.length} 条待导入`)
    for (const item of items) {
      const entry = await buildEntry({ ...item, dryRun: options.dryRun }, item.time ?? options.time ?? new Date().toISOString())
      await appendEntry(entry, options.dryRun)
    }
  }
  else {
    const entry = await buildEntry(options, options.time ?? new Date().toISOString())
    await appendEntry(entry, options.dryRun)
  }

  if (!options.dryRun)
    await mergeThinking()
}

main().catch((error) => {
  console.error(`[thinking] ${(error as Error).message}`)
  process.exit(1)
})
