import type { HttpContext } from '@adonisjs/core/http'
import axios from 'axios' // << importar axios
import { plotPayloadValidator } from '#validators/plot'
import { PlotStream } from '#services/plot_stream'
import env from '#start/env'

export default class PlotsController {
  private stream = PlotStream.getInstance()

  public async ingest({ request, response }: HttpContext) {
    try {
      const payload = await request.validateUsing(plotPayloadValidator)
      // @ts-ignore
      this.stream.pushPayload(payload)
      if (env.get('DISCORD_WEBHOOK')) {
        // @ts-ignore
        await this.stream.emitToDiscord(payload.jobId, payload.plots)
      }
      return response.json({ success: true, jobId: payload.jobId, received: payload.plots.length })
    } catch (error) {
      return response.status(400).json({
        success: false,
        message: 'Payload inválido',
        details: (error as any)?.messages ?? String(error),
      })
    }
  }

  public async filter({ request, response }: HttpContext) {
    const mutation = request.input('mutation') as string | undefined
    const rarity = request.input('rarity') as string | undefined
    const minRaw = (request.input('min') ?? request.input('minPerSecond')) as
      | string
      | number
      | undefined
    const min = this.stream.parseHumanMoney(minRaw)
    const data = this.stream.filter({ mutation, rarity, minPerSecond: min ?? undefined })
    return response.json({ success: true, count: data.length, data })
  }

  public async latest({ response }: HttpContext) {
    return response.json({ success: true, data: this.stream.dump() })
  }

  public async servers({ response }: HttpContext) {
    try {
      const placeId = 109983668079237
      const limit = 100
      const pagesToFetch = 3

      let cursor: string | null = ''
      let allServers: any[] = []

      for (let i = 0; i < pagesToFetch; i++) {
        if (cursor === null) break

        // @ts-ignore
        const { data, status } = await axios.get(
          `https://games.roblox.com/v1/games/${placeId}/servers/Public`,
          {
            params: {
              cursor,
              sortOrder: 'Desc',
              excludeFullGames: true,
              limit,
            },
            headers: { Accept: 'application/json' },
            validateStatus: () => true,
          }
        )

        if (status < 200 || status >= 300) {
          return response.status(status).json({
            ok: false,
            error: 'roblox_api_error',
            page: i + 1,
          })
        }

        const arr = Array.isArray(data?.data) ? data.data : []
        allServers.push(...arr)

        cursor = data?.nextPageCursor || null
        if (!cursor) break
      }

      return response.json({
        ok: true,
        placeId,
        totalFetched: allServers.length,
        servers: allServers.map((s) => ({
          id: s.id,
          playing: s.playing,
          maxPlayers: s.maxPlayers,
          ping: s.ping,
        })),
      })
    } catch (err) {
      return response.status(502).json({
        ok: false,
        error: (err as any)?.message ?? 'proxy_error',
      })
    }
  }
}
