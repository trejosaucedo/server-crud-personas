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

// ============== PARAMS POR CANAL (sin colores) ==============
type ChannelParams = {
  minSecret?: number
  maxSecret?: number
  minNonSecret?: number
  maxNonSecret?: number
}

type ChannelConfig = ChannelParams & {
  name: string
  webhook: string | null
  badge?: string
}

export class PlotStream {
  private static instance: PlotStream
  private buffer: { at: number; jobId: string; generatedAt: string; plots: Plot[] }[] = []
  private ttlMs = 60_000

  private watchMap = new Map<string, { term: string; mutation: string }>()

  // ====== UMBRALES BASE ======
  private static MIN_NON_SECRET = 500_000
  private static RAINBOW_5M = 5_000_000
  private static MAX_TEST = 5_000_000

  // Constantes para join
  private static readonly PLACE_ID = 109983668079237

  // Límites Discord
  private static MAX_FIELDS_PER_EMBED = 25
  private static MAX_EMBEDS_PER_MESSAGE = 10
  private static MAX_FIELD_VALUE = 1024
  private static MAX_EMBED_CHARS = 5500

  // ====== GRUPOS DE PARÁMETROS (sin colores) ======
  private static PUBLIC_PARAMS: ChannelParams = {
    minSecret: 300_000,
    maxSecret: PlotStream.MAX_TEST,
    minNonSecret: PlotStream.MIN_NON_SECRET,
    maxNonSecret: PlotStream.MAX_TEST,
  }

  private static FIVE_M_PARAMS: ChannelParams = {
    minSecret: PlotStream.RAINBOW_5M,
    maxSecret: undefined,
    minNonSecret: PlotStream.RAINBOW_5M,
    maxNonSecret: undefined,
  }

  private static FINDER66_PARAMS: ChannelParams = {
    minSecret: 300_000,
    maxSecret: PlotStream.MAX_TEST,
    minNonSecret: PlotStream.MIN_NON_SECRET,
    maxNonSecret: PlotStream.MAX_TEST,
  }

  // ====== Singleton ======
  static getInstance() {
    if (!this.instance) this.instance = new PlotStream()
    return this.instance
  }

  // ====== API pública para rutas de watchlist ======
  private norm(s: any) {
    return String(s ?? '')
      .trim()
      .toLowerCase()
  }
  private normMut(s: any) {
    return this.norm(s)
  }
  private watchKey(term: string, mutation: string) {
    return `${term}|${mutation}`
  }

  addWatch(termRaw: string, mutationRaw?: string | null) {
    const term = this.norm(termRaw)
    const mutation = this.normMut(mutationRaw)
    if (!term) return null
    const key = this.watchKey(term, mutation)
    this.watchMap.set(key, { term, mutation })
    return { term, mutation }
  }

  removeWatch(termRaw: string, mutationRaw?: string | null) {
    const term = this.norm(termRaw)
    const mutation = this.normMut(mutationRaw)
    if (!term) return false
    return this.watchMap.delete(this.watchKey(term, mutation))
  }

  clearWatch() {
    this.watchMap.clear()
  }
  getWatchList() {
    return Array.from(this.watchMap.values())
  }

  // ====== Buffer ======
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

  // ====== Utils ======
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

  // ====== Thresholds ======
  private meetsChannelThresholds(
    item: { p: number; rarity?: string },
    cfg: ChannelParams
  ): boolean {
    const isSecret = item.rarity === 'Secret'
    const min = isSecret ? cfg.minSecret : cfg.minNonSecret
    const max = isSecret ? cfg.maxSecret : cfg.maxNonSecret
    if (typeof min === 'number' && item.p < min) return false
    if (typeof max === 'number' && item.p > max) return false
    return true
  }

  /**
   * Enrutamiento independiente por canal (thresholds)
   * - DISCORD_WEBHOOK_PUBLIC
   * - DISCORD_WEBHOOK_5M
   * - DISCORD_WEBHOOK_FINDER66
   */
  async emitToDiscord(jobId: string, plots: Plot[]) {
    const hookPublic = env.get('DISCORD_WEBHOOK_PUBLIC') || null
    const hook5m = env.get('DISCORD_WEBHOOK_5M') || null
    const hookFinder66 = env.get('DISCORD_WEBHOOK_FINDER66') || null

    if (!hookPublic && !hook5m && !hookFinder66) {
      console.warn('[PlotStream] No Discord webhooks configurados; skipping post.')
      return
    }

    type Item = { name: string; p: number; plot: string; rarity?: string }
    const all: Item[] = []

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

    if (hookPublic || hook5m || hookFinder66) {
      if (all.length) {
        const channels: ChannelConfig[] = [
          { name: 'Public', webhook: hookPublic, badge: 'Finder', ...PlotStream.PUBLIC_PARAMS },
          { name: '+5M', webhook: hook5m, badge: 'Finder', ...PlotStream.FIVE_M_PARAMS },
          {
            name: 'Finder66',
            webhook: hookFinder66,
            badge: 'Finder',
            ...PlotStream.FINDER66_PARAMS,
          },
        ]
        for (const ch of channels) {
          if (!ch.webhook) continue
          const eligible = all.filter((it) => this.meetsChannelThresholds(it, ch))
          if (!eligible.length) continue
          const embeds = this.buildEmbedsMarkdown(jobId, eligible, { scopeBadge: ch.badge })
          await this.postInChunks([ch.webhook], embeds)
        }
      } else {
        console.log('[PlotStream] emitToDiscord: no items; skipping.')
      }
    }
  }

  // ===================== RENDER (Markdown ligero) =====================
  private buildEmbedsMarkdown(
    jobId: string,
    itemsRaw: Array<{ name: string; p: number; plot: string; rarity?: string }>,
    _opts?: { scopeBadge?: string }
  ) {
    const items = [...itemsRaw].sort((a, b) => b.p - a.p)

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
    const descriptionParts = [
      '**TOTAL:** ' + items.length,
      barParts.length ? barParts.join(' | ') : null,
    ].filter(Boolean) as string[]

    const descriptionJoined = descriptionParts.join('\n')
    const description =
      descriptionJoined.length > 1024 ? descriptionJoined.slice(0, 1021) + '…' : descriptionJoined

    const fields: Array<{ name: string; value: string; inline?: boolean }> = []

    // --------- META: Job/Place/Join ----------
    const placeId = PlotStream.PLACE_ID
    const joinLink = `https://chillihub1.github.io/chillihub-joiner/?placeId=${placeId}&gameInstanceId=${encodeURIComponent(
      jobId
    )}`
    const joinScript = `game:GetService("TeleportService"):TeleportToPlaceInstance(${placeId},"${jobId}",game.Players.LocalPlayer)`

    fields.push(
      { name: 'Job ID', value: '```' + jobId + '```', inline: false },
      { name: 'Place ID', value: '```' + placeId + '```', inline: false },
      { name: 'Join Link', value: `[Click to Join](${joinLink})`, inline: false },
      { name: 'Join Script', value: '```' + joinScript + '```', inline: false }
    )

    // --------- DETALLE POR PLOT ----------
    for (const [plotName, group] of orderedPlots) {
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

        const fieldName = idx === 0 ? `__**${plotName}**__` : '\u200B'
        const value = `${rarity.trim() ? `**${rarity.trim()}**` : '**Otros**'}${
          rows ? '\n' + rows : ''
        }`

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

    const title = 'Finder'
    return this.packEmbeds(title, description, fields)
  }

  // ---- Empaquetado por límites de Discord ----
  private packEmbeds(
    title: string,
    description: string,
    fields: Array<{ name: string; value: string; inline?: boolean }>
  ) {
    const embeds: any[] = []
    let current = this.newEmbed(title, description)
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
          current = this.newEmbed(title + ` (cont.)`, description)
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

  private newEmbed(title: string, description: string) {
    const hora = new Intl.DateTimeFormat('es-MX', {
      timeStyle: 'medium',
      hour12: false,
      timeZone: 'America/Mexico_City',
    }).format(new Date())
    return {
      title,
      description,
      color: 0x2ecc71,
      fields: [] as any[],
      footer: {
        text: `Hoy a las ${hora} • by qsau`,
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
