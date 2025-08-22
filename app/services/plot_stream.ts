import axios from 'axios'
import env from '#start/env'

type Generation = { raw: string; perSecond: number | null; ready: boolean }
type AnimalEmpty = { index: number | string; empty: true }
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
type JobPayload = { jobId: string; generatedAt: string; plots: Plot[] }
type FilterQuery = { mutation?: string; rarity?: string; minPerSecond?: number }

export class PlotStream {
  private static instance: PlotStream
  private buffer: { at: number; jobId: string; generatedAt: string; plots: Plot[] }[] = []
  private ttlMs = 60_000

  // Nuevos umbrales
  private static MIN_NON_SECRET = 300_000
  private static HIGHLIGHT_2M = 2_000_000
  private static RAINBOW_5M = 5_000_000

  static getInstance() {
    if (!this.instance) this.instance = new PlotStream()
    return this.instance
  }

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

  dump(): Plot[] {
    this.gc(Date.now())
    const out: Plot[] = []
    for (const chunk of this.buffer) out.push(...chunk.plots)
    return out
  }

  dumpJobs(): JobPayload[] {
    this.gc(Date.now())
    return this.buffer.map((b) => ({ jobId: b.jobId, generatedAt: b.generatedAt, plots: b.plots }))
  }

  private gc(now = Date.now()) {
    const minTs = now - this.ttlMs
    this.buffer = this.buffer.filter((e) => e.at >= minTs)
  }

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

  /**
   * Envía a ambos webhooks (MAIN y CARLOS) lo mismo:
   * - Secret: SIEMPRE (destacado B/N).
   * - No-secret: desde 300k+.
   * - +2M: resaltado.
   * - ≥5M: RAINBOW (prioridad sobre cualquier otra regla).
   */
  async emitToDiscord(jobId: string, plots: Plot[]) {
    const hookMain = env.get('DISCORD_WEBHOOK') // normal
    const hookCarlos = env.get('DISCORD_WEBHOOK_CARLOS') // +1M (ahora igual que MAIN)
    const targets = [hookMain, hookCarlos].filter(Boolean) as string[]
    if (!targets.length) return

    type Item = { name: string; p: number; plot: string; rarity?: string }
    const items: Item[] = []
    for (const plot of plots) {
      for (const ap of plot.animalPodiums) {
        const anyAp = ap as any
        if (anyAp.empty) continue
        const a = ap as AnimalFull
        const p = a.generation?.perSecond
        if (typeof p === 'number') {
          // Secret siempre pasa; no-secret solo si >= 300k
          if (a.rarity === 'Secret' || p >= PlotStream.MIN_NON_SECRET) {
            items.push({ name: a.displayName, p, plot: plot.plotSign, rarity: a.rarity })
          }
        }
      }
    }
    if (!items.length) return

    // Grupos (orden por prioridad)
    const rainbow = items.filter((i) => i.p >= PlotStream.RAINBOW_5M).sort((a, b) => b.p - a.p)
    const secret = items
      .filter((i) => i.rarity === 'Secret' && i.p < PlotStream.RAINBOW_5M)
      .sort((a, b) => b.p - a.p)
    const plus2m = items
      .filter(
        (i) =>
          i.rarity !== 'Secret' && i.p >= PlotStream.HIGHLIGHT_2M && i.p < PlotStream.RAINBOW_5M
      )
      .sort((a, b) => b.p - a.p)
    const normal = items
      .filter(
        (i) =>
          i.rarity !== 'Secret' && i.p >= PlotStream.MIN_NON_SECRET && i.p < PlotStream.HIGHLIGHT_2M
      )
      .sort((a, b) => b.p - a.p)

    const footer = { text: `SauPetNotify • ${new Date().toLocaleString()}` }

    const makeFields = (list: Item[], style: 'rainbow' | 'secret' | 'plus2m' | 'normal') => {
      return list.slice(0, 10).map((i) => {
        const baseName = i.rarity ? `${i.name} (${i.rarity})` : i.name
        if (style === 'rainbow') {
          return {
            name: `🌈 ${baseName}`,
            value: `🌈 **${this.human(i.p)}/s**\n📍 ${i.plot}`,
            inline: false,
          }
        }
        if (style === 'secret') {
          return {
            name: `🖤 **${i.name} (Secret)**`,
            value: `⬛⬜ **${this.human(i.p)}/s**\n📍 ${i.plot}`,
            inline: false,
          }
        }
        if (style === 'plus2m') {
          return {
            name: `🔥 ${baseName}`,
            value: `🔥 **${this.human(i.p)}/s**\n📍 ${i.plot}`,
            inline: false,
          }
        }
        return { name: baseName, value: `💰 **${this.human(i.p)}/s**\n📍 ${i.plot}`, inline: false }
      })
    }

    const embeds: any[] = []

    if (rainbow.length) {
      embeds.push({
        title: '🌈 RAINBOW (≥5M/s)',
        color: 0xe91e63, // color llamativo
        fields: [
          ...makeFields(rainbow, 'rainbow'),
          { name: '🆔 Job ID', value: `\`\`\`${jobId}\`\`\`` },
        ],
        footer,
      })
    }
    if (secret.length) {
      embeds.push({
        title: '⬛⬜ SECRETO (cualquier cantidad)',
        color: 0x000000, // “blanco y negro” (borde negro)
        fields: [
          ...makeFields(secret, 'secret'),
          { name: '🆔 Job ID', value: `\`\`\`${jobId}\`\`\`` },
        ],
        footer,
      })
    }
    if (plus2m.length) {
      embeds.push({
        title: '🔥 Destacados +2M/s',
        color: 0xe74c3c,
        fields: [
          ...makeFields(plus2m, 'plus2m'),
          { name: '🆔 Job ID', value: `\`\`\`${jobId}\`\`\`` },
        ],
        footer,
      })
    }
    if (normal.length) {
      embeds.push({
        title: 'PetNotify — +300k/s',
        color: 0x2ecc71,
        fields: [
          ...makeFields(normal, 'normal'),
          { name: '🆔 Job ID', value: `\`\`\`${jobId}\`\`\`` },
        ],
        footer,
      })
    }

    const payload = {
      // Encabezados grandes fuera del embed (para “markdown grande”)
      content: [
        rainbow.length ? '### 🌈 **RAINBOW (≥5M/s)**' : '',
        secret.length ? '## ⬛⬜ **SECRETO** — *cualquier cantidad*' : '',
      ]
        .filter(Boolean)
        .join('\n'),
      embeds,
      components: [
        {
          type: 1,
          components: [{ type: 2, style: 2, label: '📋 Copiar JobId', custom_id: `copy_${jobId}` }],
        },
      ],
    }

    await Promise.all(targets.map((url) => this.safePost(url, payload)))
  }

  private async safePost(url: string, payload: any) {
    try {
      await axios.post(url, payload)
    } catch {}
  }

  private human(n: number): string {
    if (n >= 1e12) return `${+(n / 1e12).toFixed(3)}T`
    if (n >= 1e9) return `${+(n / 1e9).toFixed(3)}B`
    if (n >= 1e6) return `${+(n / 1e6).toFixed(3)}M`
    if (n >= 1e3) return `${+(n / 1e3).toFixed(3)}K`
    return `${+n.toFixed(3)}`
  }
}
