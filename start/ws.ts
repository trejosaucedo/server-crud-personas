import server from '@adonisjs/core/services/server'
import Ws from '#services/ws'

const httpServer = (server as any).instance
Ws.boot(httpServer)

export default Ws
