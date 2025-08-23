import type { HttpContext } from '@adonisjs/core/http'
import axios from 'axios'
import { plotPayloadValidator } from '#validators/plot'
import { PlotStream } from '#services/plot_stream'

export default class PlotsController {
  private stream = PlotStream.getInstance()

  public async ingest({ request, response }: HttpContext) {
    try {
      const payload = await request.validateUsing(plotPayloadValidator)

      // Buffer local (TTL)
      // @ts-ignore
      this.stream.pushPayload(payload)

      // Siempre intenta emitir (internamente se salta si no hay hooks)
      // @ts-ignore
      await this.stream.emitToDiscord(payload.jobId, payload.plots)

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

      const urls = [
        'https://scrapper1-production.up.railway.app/servers',
        'https://scrapper2-production.up.railway.app/servers',
        'https://scrapper3-production.up.railway.app/servers',
      ]

      const results = await Promise.all(
        urls.map((url) =>
          axios
            .get(url, { headers: { Accept: 'application/json' }, validateStatus: () => true })
            .then((r) => (r.status >= 200 && r.status < 300 ? r.data : { ok: false, servers: [] }))
            .catch(() => ({ ok: false, servers: [] }))
        )
      )

      const allServers = results.flatMap((r) => (Array.isArray(r.servers) ? r.servers : []))
      const totalFetched = allServers.length

      return response.json({
        ok: true,
        placeId,
        totalFetched,
        servers: allServers,
      })
    } catch (err) {
      return response.status(502).json({
        ok: false,
        error: (err as any)?.message ?? 'proxy_error',
      })
    }
  }
}
