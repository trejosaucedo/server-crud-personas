import axios from 'axios'
import env from '#start/env'

type Generation = {
  raw: string
  perSecond: number | null
  ready: boolean
}

type AnimalEmpty = {
  index: number | string
  empty: true
}

type AnimalFull = {
  index: number | string
  empty: false
  displayName: string
  mutation: string
  rarity: string
  generation: Generation
}

type AnimalPodium = AnimalEmpty | AnimalFull

type Plot = {
  plotSign: string
  remainingTime: { raw: string | null; seconds: number | null }
  animalPodiums: AnimalPodium[]
  meta: { timestamp: string }
}

type JobPayload = {
  jobId: string
  generatedAt: string
  plots: Plot[]
}

type FilterQuery = {
  mutation?: string
  rarity?: string
  minPerSecond?: number
}

export class PlotStream {
  private static instance: PlotStream
  private buffer: { at: number; jobId: string; generatedAt: string; plots: Plot[] }[] = []
  private ttlMs = 60_000

  // Umbrales
  private static VIP_THRESHOLD = 8_000_000
  private static NORMAL_MIN = 1_000_000
  private static SECRET_MIN = 200_000

  static getInstance() {
    if (!this.instance) this.instance = new PlotStream()
    return this.instance
  }

  /** Inserta un payload (UN job por lote) */
  pushPayload(payload: JobPayload) {
    const now = Date.now()
    this.buffer.push({
      at: now,
      jobId: payload.jobId,
      generatedAt: payload.generatedAt,
      plots: payload.plots,
    })
    this.gc(now)
  }

  /** Devuelve todos los plots recientes (aplanado) */
  dump(): Plot[] {
    const now = Date.now()
    this.gc(now)
    const out: Plot[] = []
    for (const chunk of this.buffer) out.push(...chunk.plots)
    return out
  }

  /** Si quieres ver los jobs con su metadata */
  dumpJobs(): JobPayload[] {
    const now = Date.now()
    this.gc(now)
    return this.buffer.map((b) => ({ jobId: b.jobId, generatedAt: b.generatedAt, plots: b.plots }))
  }

  /** Limpieza por TTL */
  private gc(now = Date.now()) {
    const minTs = now - this.ttlMs
    this.buffer = this.buffer.filter((e) => e.at >= minTs)
  }

  /** Convierte "10m", "12.5m", "1b", "750k", o número a perSecond */
  parseHumanMoney(input: string | number | undefined): number | null {
    if (input === undefined || input === null) return null
    if (typeof input === 'number') return Number.isFinite(input) ? input : null

    const raw = String(input).trim().toLowerCase()
    if (raw === '') return null

    const m = raw.match(/^(\d+(?:\.\d+)?)([kmbt])$/i)
    if (m) {
      const num = Number.parseFloat(m[1])
      const suf = m[2].toLowerCase()
      const mult =
        suf === 'k' ? 1e3 : suf === 'm' ? 1e6 : suf === 'b' ? 1e9 : suf === 't' ? 1e12 : 1
      return num * mult
    }

    const asNum = Number(raw)
    if (!Number.isNaN(asNum)) return asNum

    return null
  }

  /**
   * Filtro por mutation, rarity y mínimo perSecond (ignora READY!/null)
   */
  filter(q: FilterQuery) {
    const min = q.minPerSecond ?? null
    const out: Array<{
      plotSign: string
      index: number | string
      displayName: string
      mutation: string
      rarity: string
      generation: { raw: string; perSecond: number | null }
      timestamp: string
    }> = []

    for (const chunk of this.buffer) {
      for (const plot of chunk.plots) {
        for (const a of plot.animalPodiums) {
          if ((a as AnimalEmpty).empty) continue
          const full = a as AnimalFull

          if (q.mutation && full.mutation !== q.mutation) continue
          if (q.rarity && full.rarity !== q.rarity) continue

          const psec = full.generation?.perSecond ?? null
          if (min !== null) {
            if (psec === null || psec < min) continue
          } else {
            if (psec === null) continue
          }

          out.push({
            plotSign: plot.plotSign,
            index: full.index,
            displayName: full.displayName,
            mutation: full.mutation,
            rarity: full.rarity,
            generation: { raw: full.generation.raw, perSecond: psec },
            timestamp: plot.meta.timestamp,
          })
        }
      }
    }

    return out
  }

  /** Envía al/los webhooks de Discord con la regla:
   * - Si hay ≥ 8M/s en el lote -> SOLO webhook VIP (8m).
   * - Si NO hay ≥ 8M/s -> SOLO webhook principal (normal).
   * Si no hay VIP configurado pero sí ≥ 8M/s, hace fallback al principal (con aviso).
   */
  async emitToDiscord(jobId: string, plots: Plot[]) {
    const hookMain = env.get('DISCORD_WEBHOOK') // normal
    const hookVip  = env.get('DISCORD_WEBHOOK_8M') || env.get('DISCORD_WEBHOOK2') // VIP

    // Construir items con perSecond numérico
    const items: { name: string; p: number; plot: string; rarity?: string }[] = []
    for (const plot of plots) {
      for (const ap of plot.animalPodiums) {
        const anyAp = ap as any
        if (anyAp.empty) continue
        const a = ap as AnimalFull
        const p = a.generation?.perSecond
        if (typeof p === 'number') {
          items.push({ name: a.displayName, p, plot: plot.plotSign, rarity: a.rarity })
        }
      }
    }

    // Si no hay valores numéricos -> NO emitir nada
    if (!items.length) return

    const maxPS = items.reduce((m, it) => (it.p > m ? it.p : m), 0)
    const hasVip = maxPS >= PlotStream.VIP_THRESHOLD
    const footer = { text: `SauPetNotify • ${new Date().toLocaleString()}` }

    // Relevantes para canal normal
    const relevantNormal = items
      .filter((i) =>
        i.rarity === 'Secret' ? i.p >= PlotStream.SECRET_MIN : i.p >= PlotStream.NORMAL_MIN
      )
      .sort((a, b) => b.p - a.p)

    // === VIP (≥8M/s) ===
    if (hasVip) {
      const fieldsVip = (relevantNormal.length ? relevantNormal : items).slice(0, 10).map((i) => ({
        name: i.rarity ? `${i.name} (${i.rarity})` : i.name,
        value: `💎 **${this.human(i.p)}/s**\n📍 ${i.plot}`,
        inline: false,
      }))

      if (hookVip) {
        await this.safePost(hookVip, {
          embeds: [
            {
              title: 'SauPetNotify — VIP (≥8M/s detectado)',
              color: 0xf1c40f,
              fields: [
                ...fieldsVip,
                { name: '🆔 Job ID', value: `\`\`\`${jobId}\`\`\``, inline: false },
                { name: 'Max/s', value: this.human(maxPS), inline: true },
              ],
              footer,
            },
          ],
          components: [
            {
              type: 1,
              components: [{ type: 2, style: 2, label: '📋 Copiar JobId', custom_id: `copy_${jobId}` }],
            },
          ],
        })
      } else if (hookMain) {
        // Fallback si no hay VIP configurado
        await this.safePost(hookMain, {
          embeds: [
            {
              title: 'SauPetNotify — VIP',
              color: 0xf39c12,
              fields: [
                ...fieldsVip,
                { name: '🆔 Job ID', value: `\`\`\`${jobId}\`\`\``, inline: false },
                { name: 'Max/s', value: this.human(maxPS), inline: true },
              ],
              footer,
            },
          ],
        })
      }
      return
    }

    // === Modo normal ===
    // Si no hay nada ≥1M (normal) o ≥200k (Secret) -> NO emitir nada
    if (!relevantNormal.length) return

    const fields = relevantNormal.slice(0, 10).map((i) => ({
      name: i.rarity ? `${i.name} (${i.rarity})` : i.name,
      value: `💰 **${this.human(i.p)}/s**\n📍 ${i.plot}`,
      inline: false,
    }))

    if (hookMain) {
      await this.safePost(hookMain, {
        embeds: [
          {
            title: 'PetNotify',
            color: 0x2ecc71,
            fields: [
              ...fields,
              { name: '🆔 Job ID', value: `\`\`\`${jobId}\`\`\``, inline: false },
            ],
            footer,
          },
        ],
        components: [
          {
            type: 1,
            components: [{ type: 2, style: 2, label: '📋 Copiar JobId', custom_id: `copy_${jobId}` }],
          },
        ],
      })
    }
  }


  /** POST con try/catch para no romper el flujo si un webhook falla */
  private async safePost(url: string, payload: any) {
    try {
      await axios.post(url, payload)
    } catch {
      // log si quieres
    }
  }

  private human(n: number): string {
    if (n >= 1e12) return `${+(n / 1e12).toFixed(3)}T`
    if (n >= 1e9) return `${+(n / 1e9).toFixed(3)}B`
    if (n >= 1e6) return `${+(n / 1e6).toFixed(3)}M`
    if (n >= 1e3) return `${+(n / 1e3).toFixed(3)}K`
    return `${+n.toFixed(3)}`
  }
}
