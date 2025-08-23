// app/services/plot_stream.ts
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

  // ====== UMBRALES Y COLORES ======
  private static MIN_NON_SECRET = 300_000 // Carlos: >=300k
  private static TEST_MIN = 5_000_000 // Test:   >=500k (no-secret)
  private static RAINBOW_5M = 5_000_000 // 5M+
  private static COLOR_DEFAULT = 0x95a5a6
  private static COLOR_HAS_5M = 0x2ecc71 // verde si hay 5M en ese embed
  private static COLOR_5M_ONLY = 0x0b63ff // azul para el hook +5

  // Límites Discord
  private static MAX_FIELDS_PER_EMBED = 25
  private static MAX_EMBEDS_PER_MESSAGE = 10
  private static MAX_FIELD_VALUE = 1024
  private static MAX_EMBED_CHARS = 5500

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
   * Enrutamiento:
   * - Si hay ≥5M en el job:
   *     • Enviar a +5M (solo los ≥5M)
   *     • Enviar a Carlos (Secret o ≥300k) ← también cuando hay 5M
   *     • NO enviar a Test
   * - Si NO hay ≥5M:
   *     • Carlos: Secret o ≥300k
   *     • Test: (<5M) y (Secret o ≥500k)
   */
  async emitToDiscord(jobId: string, plots: Plot[]) {
    const hookCarlos = env.get('DISCORD_WEBHOOK_CARLOS')
    const hookTest = env.get('DISCORD_WEBHOOK_TEST')
    const hook5m = env.get('DISCORD_WEBHOOK_5M')

    if (!hookCarlos && !hookTest && !hook5m) {
      console.warn('[PlotStream] No Discord webhooks configured; skipping post.')
      return
    }

    type Item = { name: string; p: number; plot: string; rarity?: string }
    const all: Item[] = []

    // Tolerante a perSecond string
    for (const plot of plots) {
      for (const ap of plot.animalPodiums) {
        const anyAp = ap as any
        if (anyAp?.empty) continue
        const a = ap as any

        let p: number | null = null
        const rawP = a?.generation?.perSecond
        if (typeof rawP === 'number' && Number.isFinite(rawP)) p = rawP
        else if (typeof rawP === 'string') {
          const cleaned = rawP.trim().replace(/\/s$/i, '').replace(/^\$/, '')
          p = this.parseHumanMoney(cleaned)
        }
        if (p === null) continue

        all.push({ name: a.displayName, p, plot: plot.plotSign, rarity: a.rarity })
      }
    }

    if (!all.length) {
      console.log('[PlotStream] emitToDiscord: no items in this job; skipping.')
      return
    }

    const has5m = all.some((i) => i.p >= PlotStream.RAINBOW_5M)

    // Helper: post a Carlos-embed con tinte si hay 5M
    const postCarlos = async () => {
      if (!hookCarlos) return
      const eligibleCarlos = all.filter(
        (i) => i.rarity === 'Secret' || i.p >= PlotStream.MIN_NON_SECRET
      )
      if (!eligibleCarlos.length) return
      const embedsCarlos = this.buildEmbedsMarkdown(jobId, eligibleCarlos, {
        tintHas5m: has5m, // pinta verde si hay 5M en el job
      })
      await this.postInChunks([hookCarlos], embedsCarlos)
    }

    if (has5m) {
      // +5M (solo ≥5M)
      if (hook5m) {
        const only5m = all.filter((i) => i.p >= PlotStream.RAINBOW_5M)
        const embeds5m = this.buildEmbedsMarkdown(jobId, only5m, {
          forceEmbedColorBlue: true,
          scopeBadge: '+5M',
        })
        await this.postInChunks([hook5m], embeds5m)
      }

      // También Carlos cuando hay 5M
      await postCarlos()

      // No Test cuando hay 5M
      return
    }

    // No hay 5M → Carlos + Test
    await postCarlos()

    if (hookTest) {
      const eligibleTest = all.filter(
        (i) => (i.rarity === 'Secret' || i.p >= PlotStream.TEST_MIN) && i.p < PlotStream.RAINBOW_5M
      )
      if (eligibleTest.length) {
        const embedsTest = this.buildEmbedsMarkdown(jobId, eligibleTest, {
          tintHas5m: false,
        })
        await this.postInChunks([hookTest], embedsTest)
      }
    }
  }

  // ===================== RENDER (Markdown ligero) =====================
  private buildEmbedsMarkdown(
    jobId: string,
    itemsRaw: Array<{ name: string; p: number; plot: string; rarity?: string }>,
    opts?: {
      tintHas5m?: boolean
      forceEmbedColorBlue?: boolean
      scopeBadge?: string // p.ej. "+5M"
    }
  ) {
    const items = [...itemsRaw].sort((a, b) => b.p - a.p)
    const has5m = items.some((i) => i.p >= PlotStream.RAINBOW_5M)

    // Resumen por rareza
    const counts = new Map<string, number>()
    for (const it of items) {
      const bucket = it.rarity === 'Secret' ? 'Secretos' : (it.rarity ?? 'Otros')
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
    }
    const barParts: string[] = []
    if (counts.has('Secretos')) barParts.push(`Secretos ${counts.get('Secretos')}`)
    for (const [k, v] of [...counts.entries()]
      // eslint-disable-next-line @typescript-eslint/no-shadow
      .filter(([k]) => k !== 'Secretos')
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      barParts.push(`${k} ${v}`)
    }

    // Agrupar por plot → luego por rareza
    type Row = { name: string; p: number; rarity: string }
    type Group = { byRarity: Map<string, Row[]> }
    const byPlot = new Map<string, Group>()
    for (const it of items) {
      const g = byPlot.get(it.plot) ?? { byRarity: new Map() }
      const rarity = it.rarity && it.rarity.trim() ? it.rarity : 'Otros'
      const arr = g.byRarity.get(rarity) ?? []
      arr.push({ name: it.name, p: it.p, rarity })
      g.byRarity.set(rarity, arr)
      byPlot.set(it.plot, g)
    }

    const orderedPlots = [...byPlot.entries()].sort((a, b) => {
      const bestA = Math.max(...[...a[1].byRarity.values()].flat().map((x) => x.p))
      const bestB = Math.max(...[...b[1].byRarity.values()].flat().map((x) => x.p))
      return bestB - bestA
    })

    // ===== TOP: JOB ID + triángulos planos (con salto después) + Mejor + totales =====
    const best = items[0]
    const TRIANGLES = '△▽△▽△▽△▽△▽△▽△▽△▽ △▽△▽△▽△▽△▽△▽△▽△▽'

    const descriptionParts = [
      '**JOB ID**',
      '```' + jobId + '```',
      TRIANGLES,
      '', // ← línea en blanco DESPUÉS de los triángulos
      best
        ? `**Mejor:** ${best.name} — **${this.human(best.p)}/s** — ${best.rarity ?? 'Otros'}`
        : null,
      `**TOTAL:** ${items.length}`,
      barParts.length ? barParts.join(' | ') : null,
    ].filter(Boolean)

    const descriptionJoined = descriptionParts.join('\n')
    const description =
      descriptionJoined.length > 1024 ? descriptionJoined.slice(0, 1021) + '…' : descriptionJoined

    // ===== Helpers (sin ANSI) =====
    const rarityHeader = (rarity: string) => `**${rarity.trim()}**`

    // ===== Fields =====
    const fields: Array<{ name: string; value: string; inline?: boolean }> = []

    for (const [plotName, group] of orderedPlots) {
      // ordenar rarezas por su mejor p
      const raritiesOrdered = [...group.byRarity.entries()].sort((a, b) => {
        const maxA = Math.max(...a[1].map((x) => x.p))
        const maxB = Math.max(...b[1].map((x) => x.p))
        return maxB - maxA
      })

      raritiesOrdered.forEach(([rarity, arr], idx) => {
        const rows = arr
          .sort((a, b) => b.p - a.p)
          .map((it) => `• ${it.name} — **${this.human(it.p)}/s**`)
          .join('\n')

        // primer bloque: header con nombre de la base; siguientes usan ZWSP para no repetir
        const fieldName = idx === 0 ? `__**${plotName}**__` : '\u200B'
        const value = `${rarityHeader(rarity)}${rows ? '\n' + rows : ''}`

        fields.push({
          name: fieldName,
          value:
            value.length > PlotStream.MAX_FIELD_VALUE
              ? value.slice(0, PlotStream.MAX_FIELD_VALUE - 1) + '…'
              : value,
          inline: false,
        })
      })
    }

    // ===== Meta del embed =====
    const title = opts?.scopeBadge ? `PetNotify • ${opts.scopeBadge}` : 'PetNotify'
    const color = opts?.forceEmbedColorBlue
      ? PlotStream.COLOR_5M_ONLY
      : opts?.tintHas5m && has5m
        ? PlotStream.COLOR_HAS_5M
        : PlotStream.COLOR_DEFAULT

    return this.packEmbeds(title, description, color, fields)
  }

  // ---- Empaquetado por límites de Discord ----
  private packEmbeds(
    title: string,
    description: string,
    color: number,
    fields: Array<{ name: string; value: string; inline?: boolean }>
  ) {
    const embeds: any[] = []
    let current = this.newEmbed(title, description, color)
    let fieldCount = 0
    let chars = this.embedSize(current)

    for (const f of fields) {
      const chunks = this.chunkFieldValue(f.value, PlotStream.MAX_FIELD_VALUE)
      for (const [i, chunk] of chunks.entries()) {
        const name = i === 0 ? f.name : `${f.name} (cont.)`
        const field = { name, value: chunk, inline: false }
        const addSize = name.length + chunk.length + 10

        const wouldOverflow =
          fieldCount >= PlotStream.MAX_FIELDS_PER_EMBED ||
          chars + addSize > PlotStream.MAX_EMBED_CHARS
        if (wouldOverflow) {
          if (current.fields.length) embeds.push(current)
          current = this.newEmbed(title + ` (cont.)`, description, color)
          fieldCount = 0
          chars = this.embedSize(current)
        }
        current.fields.push(field)
        fieldCount++
        chars += addSize
      }
    }
    if (current.fields.length) embeds.push(current)
    return embeds
  }

  private newEmbed(title: string, description: string, color: number) {
    return {
      title,
      color,
      description,
      fields: [] as any[],
      footer: {
        text: `SauPetNotify • ${new Intl.DateTimeFormat('es-MX', {
          dateStyle: 'short',
          timeStyle: 'medium',
          timeZone: 'America/Monterrey',
        }).format(new Date())} America/Monterrey`,
      },
    }
  }

  private embedSize(e: any) {
    const fieldsLen = e.fields.reduce((a: number, f: any) => a + f.name.length + f.value.length, 0)
    return (e.title?.length ?? 0) + (e.description?.length ?? 0) + fieldsLen + 50
  }

  private chunkFieldValue(s: string, max: number) {
    if (s.length <= max) return [s]
    const out: string[] = []
    let i = 0
    while (i < s.length) {
      out.push(s.slice(i, i + max))
      i += max
    }
    return out
  }

  private async postInChunks(urls: string[], embeds: any[]) {
    if (!urls.length || !embeds.length) return
    for (const url of urls) {
      let i = 0
      while (i < embeds.length) {
        const slice = embeds.slice(i, i + PlotStream.MAX_EMBEDS_PER_MESSAGE)
        await this.safePost(url, { embeds: slice })
        i += PlotStream.MAX_EMBEDS_PER_MESSAGE
      }
    }
  }

  private async safePost(url: string, payload: any) {
    try {
      const r = await axios.post(url, payload, { validateStatus: () => true })
      if (r.status < 200 || r.status >= 300) {
        console.error('Discord POST failed', { url, status: r.status, data: r.data })
        if (r.status === 429) {
          const retry = Number(r.headers?.['retry-after'] ?? 0)
          if (retry > 0 && retry < 10_000) await new Promise((res) => setTimeout(res, retry * 1000))
        }
      } else {
        console.log('Discord POST ok', { url, status: r.status })
      }
    } catch (err: any) {
      console.error('Discord POST error', {
        url,
        msg: err?.message,
        status: err?.response?.status,
        data: err?.response?.data,
      })
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
