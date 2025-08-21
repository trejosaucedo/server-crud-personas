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

  public async servers({ request, response }: HttpContext) {
    try {
      const placeId = Number(
        request.input('placeId') ?? request.input('place') ?? request.input('place_id')
      )
      if (!Number.isFinite(placeId)) {
        return response.status(400).json({ ok: false, error: 'placeId requerido' })
      }

      const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1))

      const pagesParam = Number(request.input('pages'))
      const pages = Math.max(
        1,
        Math.min(Number.isFinite(pagesParam) ? pagesParam : rand(8, 15), 30)
      )

      const maxParam = Number(request.input('max'))
      const max = Math.max(1, Math.min(Number.isFinite(maxParam) ? maxParam : 120, 500))

      const onlyWithSlots =
        String(request.input('onlyWithSlots') ?? 'true').toLowerCase() !== 'false'
      const orderInput = String(request.input('order') ?? '').toLowerCase()
      const sortOrder =
        orderInput === 'asc' || orderInput === 'desc'
          ? orderInput === 'asc'
            ? 'Asc'
            : 'Desc'
          : Math.random() < 0.5
            ? 'Asc'
            : 'Desc'

      const skipParam = Number(request.input('skip'))
      const skip = Math.max(0, Math.min(Number.isFinite(skipParam) ? skipParam : rand(0, 6), 20))

      const excludeCsv = String(request.input('exclude') ?? '')
      const exclude = excludeCsv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      const jobId = String(request.input('jobId') ?? '').trim()
      if (jobId) exclude.push(jobId)

      let cursor: string | null = null

      // “Saltar” páginas al azar para dispersar
      for (let i = 0; i < skip; i++) {
        // @ts-ignore
        const { data } = await axios.get(
          `https://games.roblox.com/v1/games/${placeId}/servers/Public`,
          {
            params: { sortOrder, limit: 100, cursor },
            headers: { Accept: 'application/json' },
            validateStatus: () => true,
          }
        )
        cursor = data?.nextPageCursor || null
        if (!cursor) break
      }

      const candidates: Array<{ id: string; playing: number; maxPlayers: number; ping?: number }> =
        []
      let fetched = 0

      for (let i = 0; i < pages; i++) {
        const { data, status } = await axios.get(
          `https://games.roblox.com/v1/games/${placeId}/servers/Public`,
          {
            params: { sortOrder, limit: 100, cursor },
            headers: { Accept: 'application/json' },
            validateStatus: () => true,
          }
        )

        if (status < 200 || status >= 300) {
          break
        }

        fetched++
        const arr = Array.isArray(data?.data) ? data.data : []
        for (const s of arr) {
          const id: string | undefined = s?.id
          const playing = Number(s?.playing) || 0
          const maxPlayers = Number(s?.maxPlayers) || 0
          if (!id) continue
          if (exclude.includes(id)) continue
          if (onlyWithSlots && maxPlayers > 0 && playing >= maxPlayers) continue
          candidates.push({ id, playing, maxPlayers, ping: s?.ping })
        }

        cursor = data?.nextPageCursor || null
        if (!cursor) break
      }

      // Mezclar (Fisher–Yates)
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
      }

      const out = candidates.slice(0, max)

      return response.json({
        ok: true,
        placeId,
        order: sortOrder,
        skip,
        pagesFetched: fetched,
        totalCollected: candidates.length,
        count: out.length,
        servers: out,
      })
    } catch (err) {
      return response.status(502).json({
        ok: false,
        error: (err as any)?.message ?? 'proxy_error',
      })
    }
  }
}
