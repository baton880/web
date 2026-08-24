import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const labPath = path.resolve(__dirname, '../tmp/weight-filter-lab.html')
const port = Math.max(1, Number(process.env.PORT) || 3000)

const server = http.createServer(async (req, res) => {
  const requestPath = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`).pathname
  if (requestPath !== '/' && requestPath !== '/weight-filter-lab.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not found')
    return
  }

  try {
    const html = await fs.readFile(labPath)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Cache-Control': 'no-store'
    })
    res.end(html)
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`Generate the lab first: ${error.message}`)
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Weight filtration lab: http://127.0.0.1:${port}/weight-filter-lab.html`)
})
