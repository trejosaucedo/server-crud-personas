import type { HttpContext } from '@adonisjs/core/http'
import { plotPayloadValidator } from '#validators/plot'
import { PlotStream } from '#services/plot_stream'
import env from '#start/env'

export default class PlotsController {
  private stream = PlotStream.getInstance()

  /**
   * POST /plots/ingest
   * Body: { jobId, generatedAt, plots: [...] }
   */
  public async ingest({ request, response }: HttpContext) {
    try {
      const payload = await request.validateUsing(plotPayloadValidator)

      // Guarda un job por lote (incluye jobId)
      // @ts-ignore
      this.stream.pushPayload(payload)

      // Opcional: enviar resumen a Discord
      if (env.get('DISCORD_WEBHOOK')) {
        // @ts-ignore
        await this.stream.emitToDiscord(payload.jobId, payload.plots)
      }

      return response.json({
        success: true,
        jobId: payload.jobId,
        received: payload.plots.length,
      })
    } catch (error) {
      return response.status(400).json({
        success: false,
        message: 'Payload inválido',
        details: (error as any)?.messages ?? String(error),
      })
    }
  }

  /**
   * GET /plots/filter?mutation=Gold&rarity=Secret&min=10m
   * - mutation (string)
   * - rarity   (string)
   * - min | minPerSecond (string|number): 10m, 1.5b, 750k, o número
   * En GET se ignoran los entries con perSecond null (READY!)
   */
  public async filter({ request, response }: HttpContext) {
    const mutation = request.input('mutation') as string | undefined
    const rarity = request.input('rarity') as string | undefined
    const minRaw = (request.input('min') ?? request.input('minPerSecond')) as
      | string
      | number
      | undefined

    const min = this.stream.parseHumanMoney(minRaw)

    const data = this.stream.filter({
      mutation,
      rarity,
      minPerSecond: min ?? undefined,
    })

    return response.json({ success: true, count: data.length, data })
  }

  /**
   * GET /plots/latest
   * Devuelve todos los plots recientes (últimos ~60s)
   */
  public async latest({ response }: HttpContext) {
    return response.json({ success: true, data: this.stream.dump() })
  }
}
