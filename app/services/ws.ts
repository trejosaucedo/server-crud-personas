// app/services/ws.ts
import type { Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'

class WsService {
  public io!: Server
  private booted = false

  public boot(httpServer: HttpServer) {
    if (this.booted) return
    if (!httpServer) {
      throw new Error('HTTP server not ready when booting WS')
    }

    this.io = new Server(httpServer, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      cors: {
        origin: env.get('CORS_ORIGIN', '*'),
        methods: ['GET', 'POST'],
        credentials: true,
      },
    })

    this.io.on('connection', (socket) => {
      socket.on('join', (payload) => {
        const room = typeof payload?.room === 'string' ? payload.room : undefined
        if (room) {
          socket.join(room)
          socket.emit('joined', { room })
        }
      })
    })

    this.booted = true
    logger.info('Socket.IO booted')
  }
}

const Ws = new WsService()
export default Ws
