import { listAllCustomTools } from './src/lib/mcp-custom'
const t0 = Date.now()
const cat = await listAllCustomTools(12_000)
console.log('耗时:', Date.now() - t0, 'ms')
console.log('tools:', cat.tools.map(t => t.name))
console.log('failures:', cat.failures)
process.exit(0)
