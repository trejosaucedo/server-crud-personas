import type { HttpContext } from '@adonisjs/core/http'
import axios from 'axios' // << importar axios
import { plotPayloadValidator } from '#validators/plot'
import { PlotStream } from '#services/plot_stream'
import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import { performance } from 'node:perf_hooks'
import crypto from 'node:crypto'

export default class PlotsController {
  private stream = PlotStream.getInstance()

  public async ingest({ request, response }: HttpContext) {
    // Correlation ID para traza completa de la petición
    const rid =
      request.header('x-request-id') || request.header('x-correlation-id') || crypto.randomUUID()

    const log = logger.child({ rid, ctrl: 'PlotsController', route: 'POST /plots/ingest' })
    const t0 = performance.now()

    // Helper pequeño para resumir plots sin spamear logs
    const summarizePlots = (plots: any[]) => {
      const summary = {
        plots: plots.length,
        podiumsTotal: 0,
        empties: 0,
        filled: 0,
        readyTrue: 0,
        perSecondMin: Number.POSITIVE_INFINITY as number,
        perSecondMax: 0,
        rarity: {} as Record<string, number>,
        mutation: {} as Record<string, number>,
      }
      for (const p of plots) {
        const arr = Array.isArray(p?.animalPodiums) ? p.animalPodiums : []
        summary.podiumsTotal += arr.length
        for (const pod of arr) {
          if (pod?.empty) summary.empties++
          else {
            summary.filled++
            if (pod?.generation?.ready === true) summary.readyTrue++
            const r = String(pod?.rarity ?? 'unknown')
            const m = String(pod?.mutation ?? 'unknown')
            summary.rarity[r] = (summary.rarity[r] ?? 0) + 1
            summary.mutation[m] = (summary.mutation[m] ?? 0) + 1
            const ps = Number(pod?.generation?.perSecond)
            if (!Number.isNaN(ps)) {
              if (ps < summary.perSecondMin) summary.perSecondMin = ps
              if (ps > summary.perSecondMax) summary.perSecondMax = ps
            }
          }
        }
      }
      if (summary.perSecondMin === Number.POSITIVE_INFINITY) summary.perSecondMin = 0
      return summary
    }

    try {
      // 1) Validación
      const tValid0 = performance.now()
      const payload = await request.validateUsing(plotPayloadValidator)
      const tValidMs = Number((performance.now() - tValid0).toFixed(1))

      const { jobId, generatedAt } = payload as any
      const summary = summarizePlots((payload as any).plots || [])
      const approxBytes = Buffer.byteLength(JSON.stringify(payload))

      log.debug(
        {
          phase: 'validated',
          jobId,
          generatedAt,
          tValidMs,
          sizeBytes: approxBytes,
          summary,
        },
        'payload validado'
      )

      // 2) Push al stream
      const tPush0 = performance.now()
      // @ts-ignore (tipos del validator vs servicio)
      this.stream.pushPayload(payload)
      const tPushMs = Number((performance.now() - tPush0).toFixed(1))
      log.debug({ phase: 'stream_push', jobId, tPushMs }, 'payload enviado al stream')

      // 3) Emitir a Discord (si aplica)
      if (env.get('DISCORD_WEBHOOK')) {
        const tHook0 = performance.now()
        try {
          // @ts-ignore
          await this.stream.emitToDiscord(payload.jobId, payload.plots)
          const tHookMs = Number((performance.now() - tHook0).toFixed(1))
          log.info(
            { phase: 'discord_emit', jobId, plots: summary.plots, tHookMs },
            'emitidos a Discord'
          )
        } catch (hookErr: any) {
          log.error(
            { phase: 'discord_emit_error', jobId, err: hookErr?.message ?? String(hookErr) },
            'falló Discord emit'
          )
        }
      } else {
        log.debug({ phase: 'discord_skip' }, 'no hay DISCORD_WEBHOOK, se omite envío')
      }

      // 4) Fin
      const totalMs = Number((performance.now() - t0).toFixed(1))
      log.info(
        {
          phase: 'done',
          jobId,
          plots: summary.plots,
          podiums: summary.podiumsTotal,
          durationMs: totalMs,
        },
        'ingest completo'
      )

      return response.json({
        success: true,
        jobId,
        received: summary.plots,
        durationMs: totalMs,
      })
    } catch (error: any) {
      const details = error?.messages ?? String(error)
      const totalMs = Number((performance.now() - t0).toFixed(1))
      log.error({ phase: 'error', durationMs: totalMs, err: details }, 'error en ingest')
      return response.status(400).json({
        success: false,
        message: 'Payload inválido',
        details,
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

      // tus microservicios
      const urls = [
        'https://scrapper1-production.up.railway.app/servers',
        'https://scrapper2-production.up.railway.app/servers',
        'https://scrapper3-production.up.railway.app/servers',
      ]

      // Ejecutar todos en paralelo
      const results = await Promise.all(
        urls.map((url) =>
          axios
            .get(url, { headers: { Accept: 'application/json' }, validateStatus: () => true })
            .then((r) => (r.status >= 200 && r.status < 300 ? r.data : { ok: false, servers: [] }))
            .catch(() => ({ ok: false, servers: [] }))
        )
      )

      // Combinar resultados
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
