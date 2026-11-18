# data/steam 使用说明

## 日常：Steam 游戏

不用管，CI 每天跑 `generate:steam` 自动更新。

## 加一款非 Steam 游戏

### 有 SRM（推荐）

1. 用 SRM 把游戏加进 Steam，它会顺便把封面下到 `grid/`
2. `pnpm sync:steam`
3. 提交推送

封面自动复制到 `covers/`，不满意就换（见下）。

### 没有 SRM，纯手动记账

在 `scripts/config.json` 的 `extraGames` 里加一条，然后 `pnpm sync:steam`：

```json
{
  "name": "Hollow Knight",
  "nameCN": "空洞骑士",
  "playtime": "30h",
  "lastPlayed": "2022-03-05"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 英文名，同时用来搜封面 |
| `nameCN` | 否 | 中文名 |
| `playtime` | 是 | `30h` / `30.5h` / `1800`（分钟） |
| `lastPlayed` | 是 | `2022-03-05` 或时间戳 |
| `appId` | 否 | 不给就自动生成 |
| `cover` | 否 | 不给就自动搜 SteamGridDB |

编号不用管，脚本自己生成，重复运行结果不变。

## 换封面

封面在 `covers/{appid}.{jpg,png}`。**直接覆盖同名文件**即可，脚本不会动它。

想先看有哪些可选：

```bash
pnpm sync:steam-local -- --list-covers "Hollow Knight"
```

挑好后把直链填进 `extraGames[].cover`，或直接下载图片改名为 `{appid}.jpg` 丢进 `covers/`。

## 命令

```bash
pnpm sync:steam                          # 同步 + 重新生成 games.json（常用）
pnpm sync:steam-local --dry-run          # 只看结果不写文件
pnpm sync:steam-local -- --list-covers "游戏名"
pnpm sync:steam-local --force            # 忽略已有封面，全部重抓
```

`sync:steam-local` 需要读本地 Steam 目录，只能在本地跑，CI 里没有。

## 编号规则（一句话）

`appid = crc32(exe + 名字)`，所以 **rom 路径或名字一改，编号就变，历史时长会断**。加游戏时一次定好路径。

编号 ≥ 2147483648 就是非 Steam 游戏，博客里那行的链接会跳到 Steam 商店落空——介意的自己在博客侧判断。
