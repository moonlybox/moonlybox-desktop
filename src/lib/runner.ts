/**
 * 极简命令路由器：不引第三方 CLI 库（骨架期零依赖）。
 * defineCommand 只做类型形状 + 规范化；runCli 手工解析 argv 分发。
 */

export interface CommandOptions {
  [key: string]: string | boolean | undefined
}

export interface CommandDef {
  description?: string
  options?: Record<string, { type: 'string' | 'boolean'; description?: string }>
  subcommands?: Record<string, CommandDef>
  run: (args: string[], options: CommandOptions) => void | Promise<void>
}

export interface CliDef {
  name: string
  version: string
  description?: string
  subcommands?: Record<string, CommandDef>
  run?: (args: string[], options: CommandOptions) => void | Promise<void>
}

export function defineCommand(def: CliDef): CliDef {
  return def
}

function parseArgs(argv: string[]): { args: string[]; options: CommandOptions } {
  const args: string[] = []
  const options: CommandOptions = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') {
      args.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const eq = key.indexOf('=')
      if (eq >= 0) {
        options[key.slice(0, eq)] = key.slice(eq + 1)
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          options[key] = next
          i++
        } else {
          options[key] = true
        }
      }
    } else {
      args.push(a)
    }
  }
  return { args, options }
}

function printHelp(def: CliDef | CommandDef, path: string[]): void {
  const isRoot = 'version' in def
  if (isRoot) {
    const root = def as CliDef
    console.log(`${root.name} v${root.version}${root.description ? ` — ${root.description}` : ''}`)
    console.log('')
    console.log('Commands:')
  } else {
    const c = def as CommandDef
    if (c.description) console.log(c.description)
    if (c.options) {
      console.log('\nOptions:')
      for (const [k, o] of Object.entries(c.options)) {
        console.log(`  --${k}${o.type === 'string' ? ' <value>' : ''}  ${o.description ?? ''}`)
      }
    }
    if (!def.subcommands) return
    console.log('\nSubcommands:')
  }
  for (const [name, sub] of Object.entries(def.subcommands ?? {})) {
    console.log(`  ${[...path, name].join(' ')}${sub.description ? `  ${sub.description}` : ''}`)
  }
}

export async function runCli(def: CliDef): Promise<void> {
  const { args, options } = parseArgs(process.argv.slice(2))

  if (options.version === true || options.v === true) {
    console.log(def.version)
    return
  }
  if (args.length === 0 && (options.help === true || options.h === true)) {
    printHelp(def, [])
    return
  }

  // 沿 subcommands 树下行
  let node: CliDef | CommandDef = def
  const path: string[] = []
  const rest = [...args]
  let current = def as CliDef | CommandDef
  while (rest.length > 0) {
    const head = rest[0]!
    const subs = current.subcommands
    if (subs && head in subs) {
      current = subs[head]!
      path.push(head)
      rest.shift()
    } else {
      break
    }
  }

  if (options.help === true || options.h === true || (path.length === 0 && !def.run)) {
    printHelp(current, path)
    return
  }

  try {
    await (current as CommandDef).run(rest, options)
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
