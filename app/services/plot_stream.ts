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
          if (a.empty) continue
          if (q.mutation && a.mutation !== q.mutation) continue
          if (q.rarity && a.rarity !== q.rarity) continue

          const psec = a.generation?.perSecond ?? null
          if (min !== null) {
            if (psec === null || psec < min) continue
          } else {
            if (psec === null) continue
          }

          out.push({
            plotSign: plot.plotSign,
            index: a.index,
            displayName: a.displayName,
            mutation: a.mutation,
            rarity: a.rarity,
            generation: { raw: a.generation.raw, perSecond: psec },
            timestamp: plot.meta.timestamp,
          })
        }
      }
    }

    return out
  }

  /** Envía al/los webhooks de Discord con la regla:
   * - Si hay ≥ 8M/s en la base -> SOLO webhook2 (VIP) y se mandan todos los hallazgos relevantes.
   * - Si NO hay ≥ 8M/s -> SOLO webhook principal (normal).
   */
  async emitToDiscord(jobId: string, plots: Plot[]) {
    const hookMain = env.get('DISCORD_WEBHOOK')   // normal (≥1M; secrets ≥200k)
    const hookVip  = env.get('DISCORD_WEBHOOK2')  // VIP (trigger si hay ≥8M)

    // --- Construir lista base de animales con perSecond numérico ---
    const items: { name: string; p: number; plot: string }[] = []
    for (const plot of plots) {
      for (const a of plot.animalPodiums) {
        if (a.empty) continue
        const p = a.generation.perSecond
        if (typeof p === 'number') {
          const rarityPart = a.rarity ? ` (${a.rarity})` : ''
          items.push({
            name: `${a.displayName}${rarityPart}`,
            p,
            plot: plot.plotSign,
          })
        }
      }
    }

    // Si no hay nada con número, avisa al principal y sal
    if (!items.length) {
      if (hookMain) {
        await this.safePost(hookMain, {
          embeds: [
            {
              title: 'SauPetNotify',
              description: `❌ No hay animales con perSecond numérico en la base`,
              color: 0xff0000,
              footer: { text: `SauPetNotify • ${new Date().toLocaleString()}` },
            },
          ],
        })
      }
      return
    }

    // --- Regla normal (relevantes): ≥1M o Secret ≥200k
    const relevant = items
      .filter((i) => {
        const isSecret = i.name.toLowerCase().includes('(secret')
        return isSecret ? i.p >= 200_000 : i.p >= 1_000_000
      })
      .sort((a, b) => b.p - a.p)

    const hasVip = items.some((i) => i.p >= 8_000_000)
    const footer = { text: `SauPetNotify • ${new Date().toLocaleString()}` }

    // ======================
    //  Modo VIP exclusivo
    // ======================
    if (hasVip && hookVip) {
      // Mandamos "todo eso" (los relevantes) únicamente al VIP
      const fieldsVip = (relevant.length ? relevant : items) // si por alguna razón no hay "relevantes", cae a todos los items
        .slice(0, 10)
        .map((i) => ({
          name: i.name,
          value: `💎 **${this.human(i.p)}/s**\n📍 ${i.plot}`,
          inline: false,
        }))

      await this.safePost(hookVip, {
        embeds: [
          {
            title: 'SauPetNotify — VIP (≥8M/s detectado)',
            color: 0xf1c40f, // dorado
            fields: [
              ...fieldsVip,
              {
                name: '🆔 Job ID',
                value: `\`\`\`${jobId}\`\`\``,
                inline: false,
              },
            ],
            footer,
          },
        ],
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 2,
                label: '📋 Copiar JobId',
                custom_id: `copy_${jobId}`,
              },
            ],
          },
        ],
      })

      // IMPORTANTE: no mandamos nada al hook principal cuando hay VIP
      return
    }

    // ======================
    //  Modo normal (no hay ≥8M/s)
    // ======================
    if (hookMain) {
      if (!relevant.length) {
        await this.safePost(hookMain, {
          embeds: [
            {
              title: 'PetNotify',
              description: `❌ No hay animales Secret ≥200k/s ni normales ≥1M/s`,
              color: 0xff0000,
              footer,
            },
          ],
        })
        return
      }

      const fields = relevant.slice(0, 10).map((i) => ({
        name: i.name,
        value: `💰 **${this.human(i.p)}/s**\n📍 ${i.plot}`,
        inline: false,
      }))

      await this.safePost(hookMain, {
        embeds: [
          {
            title: 'PetNotify',
            color: 0x2ecc71,
            fields: [
              ...fields,
              {
                name: '🆔 Job ID',
                value: `\`\`\`${jobId}\`\`\``,
                inline: false,
              },
            ],
            footer,
          },
        ],
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 2,
                label: '📋 Copiar JobId',
                custom_id: `copy_${jobId}`,
              },
            ],
          },
        ],
      })
    }
  }

  /** POST con try/catch para no romper el flujo si un webhook falla */
  private async safePost(url: string, payload: any) {
    try {
      await axios.post(url, payload)
    } catch (err) {
      // Puedes loguearlo si quieres:
      // console.error('Discord webhook error:', (err as any)?.message ?? err)
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
