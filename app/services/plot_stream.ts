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

  // === UMBRALES ===
  private static MIN_NON_SECRET = 1_000_000 // no-secret desde 1M/s
  private static RAINBOW_5M = 5_000_000 // sección RAINBOW
  private static MAX_PER_SECTION = 10 // tope por sección

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
   * Un SOLO embed por ingest, mismo payload para MAIN y CARLOS:
   * - Secret: siempre (cualquier cantidad)
   * - No-secret: ≥ 1M/s
   * - ≥ 5M/s: sección RAINBOW (arriba) con nombre en verde
   * - No-secret se agrupan por rarity (ej. Brainrot God)
   */
  async emitToDiscord(jobId: string, plots: Plot[]) {
    const hookMain = env.get('DISCORD_WEBHOOK')
    const hookCarlos = env.get('DISCORD_WEBHOOK_CARLOS')
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
        if (typeof p !== 'number') continue
        if (a.rarity === 'Secret' || p >= PlotStream.MIN_NON_SECRET) {
          items.push({ name: a.displayName, p, plot: plot.plotSign, rarity: a.rarity })
        }
      }
    }
    if (!items.length) return

    items.sort((a, b) => b.p - a.p)

    const rainbow = items.filter((i) => i.p >= PlotStream.RAINBOW_5M)
    const secrets = items.filter((i) => i.rarity === 'Secret')
    const normals = items.filter(
      (i) =>
        i.rarity !== 'Secret' && i.p >= PlotStream.MIN_NON_SECRET && i.p < PlotStream.RAINBOW_5M
    )

    // Helper para limitar
    const cap = <T>(arr: T[]) => {
      const max = PlotStream.MAX_PER_SECTION
      return { head: arr.slice(0, max), overflow: Math.max(arr.length - max, 0) }
    }

    const fields: any[] = []

    // RAINBOW primero
    if (rainbow.length) {
      const { head, overflow } = cap(rainbow)
      const valueParts = head.map((i) => {
        const green = `\u001b[0;32m${i.name}\u001b[0m`
        return `\`\`\`ansi\n${green}\n\`\`\`\n${this.human(i.p)}/s — ${i.plot}`
      })
      if (overflow) valueParts.push(`… y **${overflow}** más`)
      fields.push({ name: 'RAINBOW (≥5M/s)', value: valueParts.join('\n\n'), inline: false })
    }

    // Secretos
    if (secrets.length) {
      const { head, overflow } = cap(secrets)
      const valueParts = head.map(
        (i) => `• **${i.name} (Secret)** — ${this.human(i.p)}/s — ${i.plot}`
      )
      if (overflow) valueParts.push(`… y **${overflow}** más`)
      fields.push({ name: 'SECRETO(S)', value: valueParts.join('\n'), inline: false })
    }

    // No-secret agrupados por rarity
    if (normals.length) {
      const byRarity = normals.reduce<Record<string, Item[]>>((acc, it) => {
        const key = it.rarity && it.rarity.trim() ? it.rarity : 'Otros'
        ;(acc[key] ||= []).push(it)
        return acc
      }, {})

      // Ordena grupos por su mejor p/s desc para que lo top salga arriba
      const ordered = Object.entries(byRarity).sort((a, b) => {
        const maxA = Math.max(...a[1].map((x) => x.p))
        const maxB = Math.max(...b[1].map((x) => x.p))
        return maxB - maxA
      })

      for (const [rarity, list] of ordered) {
        list.sort((a, b) => b.p - a.p)
        const { head, overflow } = cap(list)
        const valueParts = head.map((i) => `• ${i.name} — ${this.human(i.p)}/s — ${i.plot}`)
        if (overflow) valueParts.push(`… y **${overflow}** más`)
        fields.push({ name: rarity, value: valueParts.join('\n'), inline: false })
      }
    }

    // JobId
    fields.push({ name: 'Job ID', value: `\`\`\`${jobId}\`\`\`` })

    const embed = {
      title: 'PetNotify',
      color: rainbow.length ? 0x2ecc71 : 0x95a5a6,
      description: [
        secrets.length ? `**Secretos:** ${secrets.length}` : null,
        `**Total:** ${items.length}`,
      ]
        .filter(Boolean)
        .join(' • '),
      fields,
      footer: { text: `SauPetNotify • ${new Date().toLocaleString()}` },
    }

    const payload = { embeds: [embed] }
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
